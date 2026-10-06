import assert from "node:assert/strict";
import { createHash } from "node:crypto";

const baseUrl = process.env.BASE_URL || "http://127.0.0.1:5000";
const expected = {
  highEnergyId: "agent-1786633444187-594spj",
  highEnergySha: "f35e3bff862ee974499dedce91ff79cd80f4ada9ffd717a54b4adbfe84269344",
  cinematicSha: "86a9f92c5d3aa10f3dbe61435edd34926aa03326c6e94b363302f030d8054302",
  lyricalSha: "defb53aedfc53174b1950d0f5f61ab3f2e7c69ad2b9ea7d1c37cdceed0a56885",
} as const;

interface AgentRecord {
  id: string;
  name: string;
  system_prompt: string;
  output_style?: Record<string, unknown>;
  preset_fields?: Array<{ id?: string; options?: Array<string | number | { value?: string | number }> }>;
}

const sha256 = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");

async function requestJson<T>(url: string, token: string): Promise<T> {
  const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  const payload = await response.json().catch(() => ({})) as T & { error?: string };
  assert.ok(response.ok, payload.error || `${url} 请求失败（${response.status}）`);
  return payload;
}

function count(source: string, value: string): number {
  return source.split(value).length - 1;
}

async function main() {
  const sessionResponse = await fetch(`${baseUrl}/api/auth/dev-session`, {
    headers: { "x-local-workbench": "ai-creation-studio-local" },
  });
  const session = await sessionResponse.json() as { token?: string; error?: string };
  assert.ok(sessionResponse.ok && session.token, session.error || "本地管理员测试会话不可用");

  const payload = await requestJson<{ agents: AgentRecord[] }>(`${baseUrl}/api/admin/agents`, session.token);
  const highEnergy = payload.agents.find((agent) => agent.id === expected.highEnergyId);
  const cinematic = payload.agents.find((agent) => agent.id === "agent-1786642714227-e1zid1");
  const lyrical = payload.agents.find((agent) => agent.id === "agent-1786642714448-m6iaou");
  assert.ok(highEnergy && cinematic && lyrical, "三张故事版导演卡片不完整");

  assert.equal(sha256(highEnergy.system_prompt), expected.highEnergySha, "高能线上 SHA 不匹配");
  assert.equal(sha256(cinematic.system_prompt), expected.cinematicSha, "电影版被意外修改");
  assert.equal(sha256(lyrical.system_prompt), expected.lyricalSha, "抒情版被意外修改");
  assert.equal(highEnergy.output_style?.free_canvas_coupling, false, "高能与自由画布发生耦合");
  assert.equal(highEnergy.output_style?.schema_version, "storyboard_director_output_style.v3.4.3.4.6.1");

  const prompt = highEnergy.system_prompt;
  const requiredAnchors = [
    "事实出现、误解升级、反转和结论四类语义节拍",
    "现实道具、熟悉符号、场景机关",
    "一秒识别",
    "触发点、传播方向、遮挡、碰撞结果和最终落点",
    "1600至2300个中文字符",
    "600至1000个中文字符",
    "10秒使用3至4个实际镜头",
    "15秒使用4至5个实际镜头",
    "不输出JSON",
    "**故事板分镜图文生图 Prompt（共4格或5格）**",
    "**图生视频 Prompt（10秒3至4镜或15秒4至5镜）**",
    "与格数对应的英文 Frame 句",
  ];
  for (const anchor of requiredAnchors) assert.ok(prompt.includes(anchor), `缺少协议锚点：${anchor}`);

  assert.ok(prompt.length >= 3000 && prompt.length <= 3900, `系统 Prompt 字数异常：${prompt.length}`);
  assert.equal(count(prompt, "# 全局美术定义"), 1, "美术定义重复");
  assert.equal(count(prompt, "# 视频 Prompt：只回答“怎么演”"), 1, "视频方法重复");
  const textFenceCount = count(prompt, "```text") + count(prompt, "\\`\\`\\`text");
  assert.equal(textFenceCount, 2, "固定输出模板必须恰好两个 text 代码框");
  assert.ok(!prompt.includes("故事板导演输出 JSON"), "禁止新增 JSON 输出包");
  assert.ok(!prompt.includes("storyboard_director_output.v1"), "禁止与故事板机器 JSON 耦合");
  assert.ok(!prompt.includes("canvas-prompt-presets"), "禁止与自由画布源文件耦合");

  const durationField = highEnergy.preset_fields?.find((field) => field.id === "target_duration_seconds");
  const values = (durationField?.options || [])
    .map((option) => Number(typeof option === "object" ? option.value : option))
    .sort((a, b) => a - b);
  assert.deepEqual(values, [10, 15], "高能接收模板时长必须为10/15秒");

  const history = await requestJson<{ versions: Array<{ id: string; prompt: string }> }>(
    `${baseUrl}/api/admin/prompt-versions?agent_id=${encodeURIComponent(highEnergy.id)}`,
    session.token,
  );
  assert.ok(history.versions.some((version) => sha256(version.prompt) === expected.highEnergySha), "当前版本未进入平台历史");
  assert.ok(history.versions.some((version) => sha256(version.prompt) === "7af5505d00aa65dbc90dfc2f0331453458c32b48c7e472094c1e946f83ae0b84"), "直接回滚版本缺失");

  console.log(JSON.stringify({
    passed: true,
    highEnergySha: expected.highEnergySha,
    promptChars: prompt.length,
    outputSchema: highEnergy.output_style?.schema_version,
    durations: values,
    twoTextBlocks: true,
    jsonOutput: false,
    siblingsUnchanged: true,
    freeCanvasCoupling: false,
    currentHistoryPresent: true,
    rollbackHistoryPresent: true,
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
