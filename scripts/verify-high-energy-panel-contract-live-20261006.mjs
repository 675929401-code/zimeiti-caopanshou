#!/usr/bin/env node

import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const AGENT_ID = "agent-1786843330392-emdjv2";
const EVIDENCE_PATH = path.resolve(
  ".codex-evidence/story-director-ab-20261005/high-energy-panel-contract-live-20261006.json",
);

async function requestJson(origin, headers, pathname) {
  const response = await fetch(`${origin}${pathname}`, {
    headers,
    cache: "no-store",
    signal: AbortSignal.timeout(30_000),
  });
  const body = await response.json().catch(() => ({}));
  assert.ok(response.ok, `${pathname}:HTTP_${response.status}:${String(body?.error || body?.code || "UNKNOWN").slice(0, 160)}`);
  return body;
}

function count(text, pattern) {
  return [...text.matchAll(pattern)].length;
}

export async function main() {
  const origin = String(process.env.LOCAL_NAV_ORIGIN || "").replace(/\/+$/u, "");
  const token = String(process.env.LOCAL_NAV_ADMIN_TOKEN || "").trim();
  const stepUp = String(process.env.LOCAL_ADMIN_STEP_UP_TOKEN || "").trim();
  assert.equal(origin, "http://127.0.0.1:5000", "EXACT_LOCAL_RUNTIME_REQUIRED");
  assert.ok(token && stepUp, "LOCAL_ADMIN_SESSION_REQUIRED");
  const payload = await requestJson(
    origin,
    { Authorization: `Bearer ${token}`, "x-admin-step-up": stepUp },
    "/api/admin/agents?include_configuration=1&include_prompt=1",
  );
  const agent = (payload.agents || []).find((entry) => entry.id === AGENT_ID);
  assert.ok(agent, "HIGH_ENERGY_AGENT_NOT_FOUND");
  const prompt = String(agent.system_prompt || "");
  assert.ok(prompt.length > 1000, "HIGH_ENERGY_PROMPT_MISSING");
  const layoutEvidence = prompt.split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => /四格|五格|4格|5格|第5格|第五格|全宽|panel_count/iu.test(line))
    .slice(0, 24);

  const contract = {
    declaresFourOrFivePanels: /4(?:格|\/5格)|4至5格|4格或5格/u.test(prompt),
    declaresTwoByTwoFourPanelLayout: /2[×xX*]2|two.by.two/iu.test(prompt),
    declaresFullWidthFifthPanel: /(?:第\s*5\s*格|第五格|5\s*格)[^\n]{0,100}(?:全宽|宽幅)|bottom Frame 5 full-width/iu.test(prompt),
    declaresAdaptiveSelection: /只有.*第5格|只有.*5格|不.*硬凑.*第5格|语义.*(?:选择|需要).*(?:4格|5格)/u.test(prompt),
    declaresPanelCountOutput: /panel_count/u.test(prompt),
    declaresPanelCountFourOrFiveOnly: /panel_count[^\n]{0,100}(?:只能|仅).*4.*5/u.test(prompt),
    fixedFourOnlyMarkers: count(prompt, /(?:严格|固定|只).{0,8}(?:四格|4格)/gu),
    fixedFiveOnlyMarkers: count(prompt, /(?:严格|固定|只).{0,8}(?:五格|5格)/gu),
  };
  if (!contract.declaresFourOrFivePanels
      || !contract.declaresTwoByTwoFourPanelLayout
      || !contract.declaresFullWidthFifthPanel
      || !contract.declaresAdaptiveSelection) {
    console.error(JSON.stringify({ contract, layoutEvidence }, null, 2));
  }
  assert.equal(contract.declaresFourOrFivePanels, true, "FOUR_OR_FIVE_PANEL_CONTRACT_MISSING");
  assert.equal(contract.declaresTwoByTwoFourPanelLayout, true, "FOUR_PANEL_LAYOUT_MISSING");
  assert.equal(contract.declaresFullWidthFifthPanel, true, "FIFTH_PANEL_LAYOUT_MISSING");
  assert.equal(contract.declaresAdaptiveSelection, true, "ADAPTIVE_PANEL_SELECTION_MISSING");

  const report = {
    passed: true,
    checkedAt: new Date().toISOString(),
    origin,
    agent: {
      id: agent.id,
      name: agent.name,
      modelId: agent.model_id,
      modelName: agent.model,
      promptSha256: crypto.createHash("sha256").update(prompt).digest("hex"),
      promptCharacters: prompt.length,
    },
    contract,
    layoutEvidence,
    observedCurrentAb: {
      targetDurationSeconds: 8,
      generatedPanelCount: 4,
      generatedLayout: "two_by_two",
      fivePanelLiveImageGeneratedInCurrentAb: false,
    },
    providerRequests: 0,
    paidGenerationRequests: 0,
    productionWrites: 0,
  };
  await fs.mkdir(path.dirname(EVIDENCE_PATH), { recursive: true });
  await fs.writeFile(EVIDENCE_PATH, `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  console.log(JSON.stringify(report, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await main();
