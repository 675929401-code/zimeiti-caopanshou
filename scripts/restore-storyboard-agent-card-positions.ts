import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";

const baseUrl = process.env.BASE_URL || "http://127.0.0.1:5000";

const cardOrder = [
  { id: "agent-1786633444187-594spj", name: "故事版导演｜高能夸张", sortOrder: 1 },
  { id: "agent-1786642714227-e1zid1", name: "故事版导演｜电影叙事", sortOrder: 2 },
  { id: "agent-1786642714448-m6iaou", name: "故事版导演｜抒情情感", sortOrder: 3 },
] as const;

interface PresetField {
  id: string;
  options?: string[];
  [key: string]: unknown;
}

interface AgentRecord {
  id: string;
  name: string;
  category: string;
  sort_order: number;
  is_active: boolean;
  system_prompt: string;
  preset_fields: PresetField[];
  output_style?: Record<string, unknown>;
  guide_message?: string;
  [key: string]: unknown;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

async function requestJson<T>(url: string, token?: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init.body ? { "Content-Type": "application/json; charset=utf-8" } : {}),
      ...init.headers,
    },
  });
  const payload = await response.json().catch(() => ({})) as T & { error?: string };
  assert.ok(response.ok, payload.error || `${url} 请求失败（${response.status}）`);
  return payload;
}

async function main() {
  const session = await requestJson<{ token?: string; error?: string }>(
    `${baseUrl}/api/auth/dev-session`,
    undefined,
    { headers: { "x-local-workbench": "ai-creation-studio-local" } },
  );
  assert.ok(session.token, session.error || "本地管理员测试会话不可用");

  const beforePayload = await requestJson<{ agents: AgentRecord[] }>(
    `${baseUrl}/api/admin/agents`,
    session.token,
  );
  const beforeAgents = cardOrder.map(({ id }) => {
    const agent = beforePayload.agents.find((item) => item.id === id);
    assert.ok(agent, `未找到故事版导演 ${id}`);
    return agent;
  });

  const stamp = new Date().toISOString().replace(/[:.]/g, "");
  const backupDir = `backups/storyboard-agent-card-position-${stamp}`;
  await mkdir(backupDir, { recursive: true });
  await writeFile(
    `${backupDir}/before.json`,
    JSON.stringify(
      beforeAgents.map((agent) => ({
        ...agent,
        system_prompt_sha256: sha256(agent.system_prompt),
      })),
      null,
      2,
    ),
    "utf8",
  );

  for (const card of cardOrder) {
    const body: Record<string, unknown> = {
      agentId: card.id,
      sort_order: card.sortOrder,
    };

    if (card.id === "agent-1786633444187-594spj") {
      body.output_style = {
        schema_version: "storyboard_director_output_style.v2",
        director_mode: "high_energy",
        human_format: "markdown_two_text_blocks_per_segment",
        panel_layout: "semantic_four_or_optional_panorama",
        shot_pacing: "10s_three_to_four_shots_15s_four_to_five_shots",
        target_durations: [10, 15],
      };
      body.guide_message =
        "粘贴已分段口播文案，选择3D动画风格、尺寸和10/15秒目标时长；每段依次输出可直接复制的生图 Prompt 与图生视频 Prompt 两个代码框。";
    }

    await requestJson(`${baseUrl}/api/admin/agents`, session.token, {
      method: "PUT",
      body: JSON.stringify(body),
    });
  }

  const afterPayload = await requestJson<{ agents: AgentRecord[] }>(
    `${baseUrl}/api/admin/agents`,
    session.token,
  );
  const afterAgents = cardOrder.map(({ id, name, sortOrder }) => {
    const agent = afterPayload.agents.find((item) => item.id === id);
    assert.ok(agent, `恢复后未找到 ${name}`);
    assert.equal(agent.name, name);
    assert.equal(agent.category, "引流带货");
    assert.equal(agent.sort_order, sortOrder);
    assert.equal(agent.is_active, true);
    return agent;
  });

  const highEnergy = afterAgents[0];
  const durationField = highEnergy.preset_fields.find((field) => field.id === "target_duration_seconds");
  assert.deepEqual(durationField?.options, ["10", "15"]);
  assert.deepEqual(highEnergy.output_style?.target_durations, [10, 15]);
  assert.equal(highEnergy.output_style?.human_format, "markdown_two_text_blocks_per_segment");
  assert.equal("machine_schema" in (highEnergy.output_style || {}), false);
  assert.match(highEnergy.system_prompt, /【原始高能核心恢复与15秒隔离适配 v6\.5】/u);
  assert.doesNotMatch(highEnergy.guide_message || "", /JSON|机器包|8\/10\/15/u);

  const publicPayload = await requestJson<{ bots: AgentRecord[] }>(`${baseUrl}/api/bots`);
  const visibleCategory = (publicPayload.bots || [])
    .filter((agent) => agent.category === "引流带货" && agent.is_active)
    .sort((a, b) => a.sort_order - b.sort_order);
  assert.deepEqual(
    visibleCategory.slice(0, 3).map((agent) => agent.id),
    cardOrder.map((card) => card.id),
  );

  await writeFile(
    `${backupDir}/after.json`,
    JSON.stringify(
      afterAgents.map((agent) => ({
        id: agent.id,
        name: agent.name,
        category: agent.category,
        sort_order: agent.sort_order,
        is_active: agent.is_active,
        preset_fields: agent.preset_fields,
        output_style: agent.output_style,
        guide_message: agent.guide_message,
        system_prompt_sha256: sha256(agent.system_prompt),
      })),
      null,
      2,
    ),
    "utf8",
  );

  console.log(JSON.stringify({
    passed: true,
    backupDir,
    visibleTopThree: visibleCategory.slice(0, 3).map((agent) => ({
      id: agent.id,
      name: agent.name,
      sort_order: agent.sort_order,
    })),
    highEnergy: {
      promptChars: highEnergy.system_prompt.length,
      promptSha256: sha256(highEnergy.system_prompt),
      durations: durationField?.options,
      outputStyle: highEnergy.output_style,
      guideMessage: highEnergy.guide_message,
    },
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
