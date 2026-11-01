import fs from "node:fs/promises";

// Offline executability test: feed the live DB prompt to Claude and see whether
// an independent model can follow it well enough to produce a valid package.
const rt = JSON.parse(
  (await fs.readFile("F:/总项目文件/Skill存储系统/运行数据/自媒体操盘手/local-data-20260902/config/runtime.json", "utf8")).replace(/^\uFEFF/u, ""),
);
const sb = rt.supabaseUrl.replace(/\/$/u, "");
const headers = { apikey: rt.serviceRoleKey, Authorization: `Bearer ${rt.serviceRoleKey}` };

// 1) live prompt from DB
const aq = new URL("/rest/v1/agents", sb);
aq.searchParams.set("select", "system_prompt,config_revision");
aq.searchParams.set("id", "eq.agent-1786843330392-emdjv2");
const agent = (await (await fetch(aq, { headers })).json())[0];
if (!agent?.system_prompt) throw new Error("NO_PROMPT");

// 2) claude credentials
const mq = new URL("/rest/v1/llm_models", sb);
mq.searchParams.set("select", "api_endpoint,api_key,model_name");
mq.searchParams.set("id", "eq.3af4f2e6-a51f-44f6-ad17-9e6412147c81");
const model = (await (await fetch(mq, { headers })).json())[0];
if (!model?.api_key) throw new Error("NO_CLAUDE_KEY");

const userMsg = [
  "分段文案：",
  "1.【很多主人以为柯基屁股圆就是可爱，其实那是超重信号。从正上方拍一张俯视图，腰线两侧凹进去才健康。】",
  "",
  "分段时长：10秒版：每段3-4个镜头",
  "视频比例：16:9",
  "动画风格：皮克斯式高能3D宠物科普动画",
  "主人性别：文案优先，未指定默认女主人",
  "狗狗品种：文案优先，未指定默认柯基",
  "特殊备注：无",
  "视觉资产模式：普通模式",
].join("\n");

const baseUrl = String(model.api_endpoint).replace(/\/+$/u, "");
const url = baseUrl.endsWith("/v1") ? `${baseUrl}/chat/completions` : `${baseUrl}/v1/chat/completions`;
const res = await fetch(url, {
  method: "POST",
  headers: { Authorization: `Bearer ${model.api_key}`, "Content-Type": "application/json" },
  signal: AbortSignal.timeout(900_000),
  body: JSON.stringify({
    model: model.model_name,
    messages: [
      { role: "system", content: agent.system_prompt },
      { role: "user", content: userMsg },
    ],
    stream: false, max_tokens: 16000, temperature: 0.4,
  }),
});
const raw = await res.text();
const dir = "F:/总项目文件/Skill存储系统/01_网页开发项目/自媒体操盘手/当前版本/.codex-evidence/offline-exec-v373-runA-20261022";
await fs.mkdir(dir, { recursive: true });
await fs.writeFile(`${dir}/raw-response.json`, raw, "utf8");

let summary = { http: res.status, promptRevision: agent.config_revision, promptChars: agent.system_prompt.length };
try {
  const j = JSON.parse(raw);
  const c = j?.choices?.[0]?.message?.content;
  if (typeof c === "string") {
    await fs.writeFile(`${dir}/reply.txt`, c, "utf8");
    const m = c.match(/<!--\s*storyboard_director_output:v1\s*([\s\S]*?)-->/i);
    let pkgOk = false;
    if (m) {
      try { JSON.parse(m[1]); pkgOk = true; await fs.writeFile(`${dir}/package.json`, m[1], "utf8"); } catch {}
    }
    const text = c;
    Object.assign(summary, {
      replyChars: c.length,
      machineComment: Boolean(m),
      packageParsed: pkgOk,
      lifecycle: ["出现", "浮现", "增强", "扩散", "碰撞", "接触", "收束", "归位"].filter((w) => text.includes(w)),
      hasE: (text.match(/E\d{1,2}/gu) || []).slice(0, 6),
      hasS: (text.match(/S\d/gu) || []).slice(0, 6),
      climax: ["聚光", "舞台", "放射线", "光柱"].filter((w) => text.includes(w)),
      shotCount: (text.match(/actual_shot_count"\s*:\s*(\d+)/u) || [])[1] ?? null,
      shotRanges: (text.match(/"start_seconds"\s*:\s*([\d.]+)/gu) || []).length,
    });
  } else Object.assign(summary, { error: JSON.stringify(j).slice(0, 300) });
} catch { summary.rawHead = raw.slice(0, 300); }
console.log(JSON.stringify(summary, null, 2));
