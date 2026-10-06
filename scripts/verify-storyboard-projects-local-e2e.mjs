import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const origin = process.env.LOCAL_NAV_ORIGIN || "http://127.0.0.1:5000";
const token = process.env.LOCAL_NAV_ADMIN_TOKEN?.trim();
assert.equal(origin, "http://127.0.0.1:5000", "Fixed local preview required");
assert.ok(token, "Verified local administrator session required");

const marker = `e2e-storyboard-${Date.now()}-${randomUUID().slice(0, 8)}`;
const endpoint = "/api/storyboard/projects";
const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
const report = { observedAt: new Date().toISOString(), origin, marker, providerCalls: 0, steps: [], passed: false };

async function request(method, suffix = "", body, expectedStatus = 200) {
  const response = await fetch(`${origin}${endpoint}${suffix}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: "no-store",
    signal: AbortSignal.timeout(30_000),
  });
  const data = await response.json().catch(() => ({}));
  assert.equal(response.status, expectedStatus, `${method} ${suffix || endpoint} returned ${response.status}`);
  return data;
}

const now = Date.now();
const document = {
  id: marker,
  title: "分镜工程历史端到端验收",
  createdAt: now,
  updatedAt: now,
  ratio: "16:9",
  imageResolution: "2K",
  videoResolution: "1080p",
  videoDuration: 10,
  imageModelId: "",
  videoModelId: "",
  cards: [{
    id: `${marker}-shot-1`,
    order: 1,
    imagePrompt: "一只金毛犬站在明亮客厅中央。",
    videoPrompt: "镜头缓慢推进，金毛犬自然抬头。",
    referenceImageUrls: [],
    imageStatus: "idle",
    videoStatus: "idle",
  }],
};

try {
  const me = await fetch(`${origin}/api/auth/me`, { headers, signal: AbortSignal.timeout(20_000) });
  assert.equal(me.status, 200);
  assert.equal((await me.json()).user?.role, "admin");

  const created = await request("POST", "", { document, expectedRevision: 0 });
  assert.equal(created.project?.id, marker);
  assert.equal(created.project?.revision, 1);
  report.steps.push({ stage: "create", revision: 1 });

  const firstRead = await request("GET", `?id=${encodeURIComponent(marker)}`);
  assert.equal(firstRead.project?.document?.title, document.title);
  assert.equal(firstRead.project?.document?.cards?.[0]?.videoPrompt, document.cards[0].videoPrompt);
  report.steps.push({ stage: "refresh-read", cardCount: firstRead.project.cardCount });

  const editedDocument = {
    ...firstRead.project.document,
    title: "分镜工程历史端到端验收（已编辑）",
    updatedAt: Date.now(),
    cards: [{ ...firstRead.project.document.cards[0], videoPrompt: "镜头环绕半圈，金毛犬走向窗边。" }],
  };
  const edited = await request("POST", "", { document: editedDocument, expectedRevision: 1 });
  assert.equal(edited.project?.revision, 2);
  report.steps.push({ stage: "edit", revision: 2 });

  const stale = await request("POST", "", { document: { ...editedDocument, title: "过期窗口修改" }, expectedRevision: 1 }, 409);
  assert.equal(stale.code, "REVISION_CONFLICT");
  report.steps.push({ stage: "stale-write-rejected", status: 409 });

  const list = await request("GET");
  assert.ok(list.projects?.some((project) => project.id === marker && project.revision === 2));
  const secondRead = await request("GET", `?id=${encodeURIComponent(marker)}`);
  assert.equal(secondRead.project?.document?.title, editedDocument.title);
  assert.equal(secondRead.project?.document?.cards?.[0]?.videoPrompt, editedDocument.cards[0].videoPrompt);
  report.steps.push({ stage: "list-and-edited-readback", visible: true });

  const removed = await request("DELETE", "", { id: marker, expectedRevision: 2 });
  assert.equal(removed.deleted, true);
  const missing = await request("GET", `?id=${encodeURIComponent(marker)}`, undefined, 404);
  assert.equal(missing.code, "PROJECT_NOT_FOUND");
  const after = await request("GET");
  assert.equal(after.projects?.some((project) => project.id === marker), false);
  report.steps.push({ stage: "delete-and-hide", visible: false });
  report.passed = true;
} finally {
  const outputDir = path.resolve(".codex-evidence", "storyboard-projects-local-e2e");
  await mkdir(outputDir, { recursive: true });
  const output = path.join(outputDir, `${marker}.json`);
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" });
  console.log(JSON.stringify({ ...report, output }, null, 2));
}

