import fs from "node:fs/promises";

// Second pass: have Claude Opus 5.5 review the integrated v3.4.0 prompt.
const rt = JSON.parse(
  (await fs.readFile("F:/总项目文件/Skill存储系统/运行数据/自媒体操盘手/local-data-20260902/config/runtime.json", "utf8")).replace(/^\uFEFF/u, ""),
);
const supabase = rt.supabaseUrl.replace(/\/$/u, "");
const headers = { apikey: rt.serviceRoleKey, Authorization: `Bearer ${rt.serviceRoleKey}` };
const q = new URL("/rest/v1/llm_models", supabase);
q.searchParams.set("select", "api_endpoint,api_key,model_name");
q.searchParams.set("id", "eq.3af4f2e6-a51f-44f6-ad17-9e6412147c81");
const row = (await (await fetch(q, { headers })).json())[0];
if (!row?.api_key) throw new Error("NO_CLAUDE_KEY");

const promptPath = "F:/总项目文件/Skill存储系统/01_网页开发项目/自媒体操盘手/当前版本/prompts/storyboard-high-energy-v3.4.0-20261022.md";
const full = (await fs.readFile(promptPath, "utf8")).replace(/^\uFEFF/u, "");

const system = `你是商业级 AI 智能体提示词架构师，做过大量视频生成类智能体的交付评审。你的评审必须直指问题、给出可执行改法，不写客套话，不重复原文。`;

const user = `下面是一份短视频分镜导演智能体的完整系统提示词（${full.length} 字）。它服务一个真实产品：用户上传已按语义分好的口播文案段（8/10/15 秒），它输出故事板生图提示词 + 图生视频提示词。

产品约束（不可改动，评审时视为硬边界）：
1. 接收卡固定 9 个字段：分段文案、分段时长、视频比例、动画风格、主人性别、狗狗品种、特殊备注、视觉资产模式、生成模型。
2. 输出格式固定：可见正文两个 text 代码框（先生图后视频）+ 末尾 HTML 注释机器包（storyboard_director_output.v1），必须能被产品校验器解析后才能推送到分镜工作台。
3. 8 秒 3 镜 / 10 秒 3 镜 / 15 秒 4 镜（上限 5）。
4. 动画风格库 6 套预设必须保留，因为用户在卡片上选了风格，智能体必须直接调用，不能临时想。

目标：它输出的提示词，交给图像/视频模型生成后，画面要达到对标博主的水准（对标账号 18 条宠物科普短视频，已拆 108 帧）。

请按下面四块给评审，直接给结论和改法：

## 一、硬伤
会导致产品用不了、推送失败、或明显跑偏的问题。逐条列，写清位置和改法。

## 二、内部矛盾
前后条款互相打架、或新旧两套逻辑（前文包装方法论 vs N18 演绎层）冲突的地方。

## 三、达不到对标水准的具体缺口
只讲画面演绎这一层：还缺什么，才不能稳定产出对标级镜头。

## 四、商业成熟方案该怎么写
如果这是一份要交付给客户的产品提示词，你会怎么组织？给出结构层面的建议（不要重写全文，只要结构和原则）。

要求：全部中文；每条都指到具体位置；不要泛泛而谈；不超过 6000 字。

=== 提示词全文开始 ===
${full}
=== 提示词全文结束 ===`;

const baseUrl = String(row.api_endpoint).replace(/\/+$/u, "");
const url = baseUrl.endsWith("/v1") ? `${baseUrl}/chat/completions` : `${baseUrl}/v1/chat/completions`;
const res = await fetch(url, {
  method: "POST",
  headers: { Authorization: `Bearer ${row.api_key}`, "Content-Type": "application/json" },
  signal: AbortSignal.timeout(900_000),
  body: JSON.stringify({
    model: row.model_name,
    messages: [{ role: "system", content: system }, { role: "user", content: user }],
    stream: false, max_tokens: 12000, temperature: 0.3,
  }),
});
const raw = await res.text();
const outDir = "F:/总项目文件/Skill存储系统/01_网页开发项目/自媒体操盘手/当前版本/.codex-evidence/claude-review-v340-20261022";
await fs.mkdir(outDir, { recursive: true });
await fs.writeFile(`${outDir}/raw-response.json`, raw, "utf8");
let summary = { http: res.status, bytes: raw.length };
try {
  const j = JSON.parse(raw);
  const c = j?.choices?.[0]?.message?.content;
  if (typeof c === "string") {
    await fs.writeFile(`${outDir}/review.md`, c, "utf8");
    Object.assign(summary, { chars: c.length, head: c.slice(0, 300) });
  } else Object.assign(summary, { error: JSON.stringify(j).slice(0, 400) });
} catch { summary.rawHead = raw.slice(0, 400); }
console.log(JSON.stringify(summary, null, 2));
