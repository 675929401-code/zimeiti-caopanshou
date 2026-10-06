import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { basename } from "node:path";

const baseUrl = process.env.BASE_URL || "http://127.0.0.1:5000";
const target = {
  id: "agent-1786633444187-594spj",
  name: "故事版导演｜高能夸张",
  expectedSha: "a795e8f08bc0ba93454fdec399ac15ace6b6574d586974ac8f4ee5578b554a98",
} as const;
const siblingExpectedShas = new Map([
  ["agent-1786642714227-e1zid1", "86a9f92c5d3aa10f3dbe61435edd34926aa03326c6e94b363302f030d8054302"],
  ["agent-1786642714448-m6iaou", "defb53aedfc53174b1950d0f5f61ab3f2e7c69ad2b9ea7d1c37cdceed0a56885"],
]);

const baselineFiles = [
  ".tmp-e2e/storyboard-high-energy-vnext4-3-3-a-husky-hearing-20260815-suite.json",
  ".tmp-e2e/storyboard-high-energy-vnext4-3-3-b-ear-health-20260815-suite.json",
  ".tmp-e2e/storyboard-high-energy-vnext4-3-3-c-gift-comfort-20260815-2-suite.json",
  ".tmp-e2e/high-energy-vnext4-3-3-a-husky-hearing-pro2k-20260815-image.png",
  ".tmp-e2e/high-energy-vnext4-3-3-b-ear-health-pro2k-20260815-image.png",
  ".tmp-e2e/high-energy-vnext4-3-3-c-gift-comfort-pro2k-20260815-image.png",
  ".tmp-e2e/high-energy-vnext4-3-3-a-husky-hearing-pro2k-20260815-result.json",
  ".tmp-e2e/high-energy-vnext4-3-3-b-ear-health-pro2k-20260815-result.json",
  ".tmp-e2e/high-energy-vnext4-3-3-c-gift-comfort-pro2k-20260815-result.json",
  ".tmp-e2e/storyboard-high-energy-vnext4-3-3-generalization-final-gate.json",
  "public/storyboard-reviews/high-energy-vnext4-3-3-a-husky-hearing-pro2k-20260815.json",
  "public/storyboard-reviews/high-energy-vnext4-3-3-b-ear-health-pro2k-20260815.json",
  "public/storyboard-reviews/high-energy-vnext4-3-3-c-gift-comfort-pro2k-20260815.json",
] as const;
const reviewUrls = [
  "http://127.0.0.1:5000/storyboard-workbench?review=high-energy-vnext4-3-3-a-husky-hearing-pro2k-20260815",
  "http://127.0.0.1:5000/storyboard-workbench?review=high-energy-vnext4-3-3-b-ear-health-pro2k-20260815",
  "http://127.0.0.1:5000/storyboard-workbench?review=high-energy-vnext4-3-3-c-gift-comfort-pro2k-20260815",
] as const;

interface PromptVersion { id: string; prompt: string; created_at?: string }
interface AgentRecord { id: string; name: string; system_prompt: string; output_style?: Record<string, unknown>; [key: string]: unknown }
function sha256(value: string | Buffer): string { return createHash("sha256").update(value).digest("hex"); }
async function requestJson<T>(url: string, token: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(init.body ? { "Content-Type": "application/json; charset=utf-8" } : {}),
      ...init.headers,
    },
  });
  const payload = await response.json().catch(() => ({})) as T & { error?: string };
  assert.ok(response.ok, payload.error || `${url} 请求失败（${response.status}）`);
  return payload;
}

async function main() {
  const sessionResponse = await fetch(`${baseUrl}/api/auth/dev-session`, { headers: { "x-local-workbench": "ai-creation-studio-local" } });
  const session = await sessionResponse.json() as { token?: string; error?: string };
  assert.ok(sessionResponse.ok && session.token, session.error || "本地管理员测试会话不可用");
  const payload = await requestJson<{ agents: AgentRecord[] }>(`${baseUrl}/api/admin/agents`, session.token);
  const agent = payload.agents.find((item) => item.id === target.id && item.name === target.name);
  assert.ok(agent, "未找到高能故事版导演");
  assert.equal(sha256(agent.system_prompt), target.expectedSha, "高能版当前Prompt不是预期vNext.4.3.3");
  for (const [id, expectedSha] of siblingExpectedShas) {
    const sibling = payload.agents.find((item) => item.id === id);
    assert.ok(sibling && sha256(sibling.system_prompt) === expectedSha, `禁止修改的卡片基线异常：${id}`);
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "");
  const backupDir = `backups/storyboard-high-energy-vnext4-3-3-positive-baseline-${stamp}`;
  await mkdir(`${backupDir}/agent`, { recursive: true });
  await mkdir(`${backupDir}/evidence`, { recursive: true });
  await writeFile(`${backupDir}/agent/${agent.id}.json`, `${JSON.stringify(agent, null, 2)}\n`, "utf8");
  await requestJson(`${baseUrl}/api/admin/prompt-versions`, session.token, {
    method: "POST",
    body: JSON.stringify({ agent_id: agent.id, prompt: agent.system_prompt, max_versions: 20 }),
  });
  const history = await requestJson<{ versions: PromptVersion[] }>(`${baseUrl}/api/admin/prompt-versions?agent_id=${encodeURIComponent(agent.id)}`, session.token);
  const rollbackVersion = history.versions.find((version) => sha256(version.prompt) === target.expectedSha);
  assert.ok(rollbackVersion, "vNext.4.3.3未保存为平台回滚历史");

  const copied: Array<{ source: string; backup: string; bytes: number; sha256: string }> = [];
  for (const source of baselineFiles) {
    const contents = await readFile(source);
    const destination = `${backupDir}/evidence/${basename(source)}`;
    await copyFile(source, destination);
    copied.push({ source, backup: destination, bytes: contents.length, sha256: sha256(contents) });
  }
  const manifest = {
    status: "frozen_user_accepted_positive_baseline",
    frozenAt: new Date().toISOString(),
    agentId: agent.id,
    promptSha256: target.expectedSha,
    promptHistoryId: rollbackVersion.id,
    rollback: `在后台Prompt历史选择 ${rollbackVersion.id} 恢复；本地完整快照见 ${backupDir}/agent/${agent.id}.json`,
    reviewUrls,
    conversations: [
      "conv_storyboard_semantic_vnext_high_energy_1786792829013_oxcuwg",
      "conv_storyboard_semantic_vnext_high_energy_1786792829067_ypd3jr",
      "conv_storyboard_semantic_vnext_high_energy_1786792998623_jlkn6x",
    ],
    imageRoute: { databaseId: "gpt-image-2-chA-1", publicId: "pm_HabdJ5rvD_L3-HUkfMUmGsrm", resolution: "2K", pixels: "2560x1440" },
    baselineCostCny: 0.6,
    copied,
    siblingsUnchanged: [...siblingExpectedShas.entries()].map(([id, promptSha256]) => ({ id, promptSha256 })),
    freeCanvasTouched: false,
  };
  await writeFile(`${backupDir}/manifest.json`, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ passed: true, backupDir, promptSha256: target.expectedSha, promptHistoryId: rollbackVersion.id, evidenceCount: copied.length }, null, 2));
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
