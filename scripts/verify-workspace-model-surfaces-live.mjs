#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";

const origin = String(process.env.LOCAL_NAV_ORIGIN || "http://127.0.0.1:5000").replace(/\/+$/u, "");
const token = String(process.env.R267_CUSTOMER_TOKEN || "").trim();
const output = path.resolve(".codex-evidence/workspace-model-surfaces-live-20260920/report.json");

function capabilities(model) {
  return model?.capabilities && typeof model.capabilities === "object" ? model.capabilities : {};
}

function storyboardIssue(model) {
  const caps = capabilities(model);
  const identity = `${model?.displayName || ""} ${model?.name || ""}`;
  if (caps.supportsImageInput !== true) return "image-input";
  if (caps.requiresSourceVideo === true) return "source-video";
  if (caps.requiresLastFrame === true || /首尾帧|first[\s_-]*last/iu.test(identity)) return "last-frame";
  if (Number(caps.minReferenceAudios || 0) > 0) return "audio";
  if (Number(caps.minReferenceImages || 0) > 1) return "multi-image";
  if (/数字人|口播|口型|lip[\s_-]*sync|talking[\s_-]*head/iu.test(identity)) return "digital-human";
  return "";
}

async function models(pathname) {
  const response = await fetch(`${origin}${pathname}`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
    signal: AbortSignal.timeout(20_000),
  });
  const body = await response.json().catch(() => ({}));
  assert.ok(response.ok && Array.isArray(body.models), `${pathname} returned ${response.status}`);
  assert.ok(body.models.length > 0, `${pathname} returned an empty assigned catalog`);
  assert.doesNotMatch(JSON.stringify(body), /api_key|secret:\/\/|sk-[A-Za-z0-9]|api_endpoint/u, `${pathname} exposed a private binding`);
  assert.equal(new Set(body.models.map((model) => model.id)).size, body.models.length, `${pathname} returned duplicate models`);
  return body.models;
}

export async function main() {
  assert.equal(origin, "http://127.0.0.1:5000", "LOCAL_ONLY_ORIGIN_REQUIRED");
  assert.ok(token, "LOCAL_CUSTOMER_TOKEN_REQUIRED");
  const imageSurfaces = ["image-workbench", "cover-studio", "storyboard-workbench", "free-canvas", "film-studio"];
  const videoSurfaces = ["video-page", "storyboard-workbench", "free-canvas", "film-studio"];
  const imageEntries = await Promise.all(imageSurfaces.map(async (surface) => [surface, await models(`/api/cover-models?surface=${surface}`)]));
  const videoEntries = await Promise.all(videoSurfaces.map(async (surface) => [surface, await models(`/api/video/models?surface=${surface}`)]));
  const catalogs = Object.fromEntries([...imageEntries.map(([surface, value]) => [`image:${surface}`, value]), ...videoEntries.map(([surface, value]) => [`video:${surface}`, value])]);

  for (const surface of ["storyboard-workbench", "film-studio"]) {
    const incompatible = catalogs[`video:${surface}`].filter((model) => storyboardIssue(model));
    assert.deepEqual(incompatible.map((model) => ({ name: model.displayName, issue: storyboardIssue(model) })), [], `${surface} leaked incompatible video models`);
  }
  for (const [key, list] of Object.entries(catalogs)) {
    assert.equal(list.some((model) => /数字人|照片说话|对口型|lip[\s_-]*sync|talking[\s_-]*head/iu.test(`${model.displayName || ""} ${model.name || ""}`)), false,
      `${key} leaked a dedicated digital-human model`);
  }

  const report = {
    checkedAt: new Date().toISOString(),
    origin,
    counts: Object.fromEntries(Object.entries(catalogs).map(([key, list]) => [key, {
      total: list.length,
      selectable: list.filter((model) => capabilities(model).available !== false).length,
    }])),
    storyboardCapabilityIssues: 0,
    filmStudioCapabilityIssues: 0,
    secretLeaks: 0,
    paidGenerationRequests: 0,
    databaseWrites: 0,
  };
  await fs.mkdir(path.dirname(output), { recursive: true });
  await fs.writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ passed: true, ...report, output }));
}

if (import.meta.url === new URL(`file://${process.argv[1].replace(/\\/gu, "/")}`).href) await main();
