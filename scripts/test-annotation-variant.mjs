import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

// One-shot: ask the agent for the ANNOTATED storyboard variant, then generate the image.
const origin = String(process.env.LOCAL_NAV_ORIGIN || "").replace(/\/+$/u, "");
const token = String(process.env.LOCAL_NAV_ADMIN_TOKEN || "").trim();
assert.equal(origin, "http://127.0.0.1:5000", "EXACT_LOCAL_RUNTIME_REQUIRED");
assert.ok(token, "LOCAL_NAV_ADMIN_TOKEN_REQUIRED");

const OUT = path.resolve(".codex-evidence/annotation-variant-20261022");
await fs.mkdir(OUT, { recursive: true });

// ---- 1) ask for annotated variant
const key1 = `annot-llm-${crypto.randomUUID()}`.replace(/[^a-zA-Z0-9_-]/gu, "");
const res1 = await fetch(`${origin}/api/llm`, {
  method: "POST",
  headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "Idempotency-Key": key1 },
  cache: "no-store", signal: AbortSignal.timeout(300_000),
  body: JSON.stringify({
    client_request_id: key1,
    messages: [{ role: "user", content: [
      "分段文案：", "1.【很多主人以为柯基屁股圆就是可爱，其实那是超重信号。从正上方拍一张俯视图，腰线两侧凹进去才健康。】", "",
      "分段时长：10秒版：每段3-4个镜头", "视频比例：16:9",
      "动画风格：皮克斯式高能3D宠物科普动画",
      "主人性别：文案优先，未指定默认女主人", "狗狗品种：文案优先，未指定默认柯基",
      "特殊备注：需要图内注释（注释版）", "视觉资产模式：普通模式",
    ].join("\n") }],
    agentId: "agent-1786843330392-emdjv2", agentName: "3D故事导演｜高能版",
    stream: false, maxContextRounds: 0, enable_web_search: false,
  }),
});
const p1 = await res1.json().catch(() => ({}));
assert.ok(res1.ok, `LLM_HTTP_${res1.status}`);
const content = String(p1?.choices?.[0]?.message?.content || "");
await fs.writeFile(path.join(OUT, "reply.txt"), content, "utf8");
const m = content.match(/<!--\s*storyboard_director_output:v1\s*([\s\S]*?)-->/i);
assert.ok(m, "MACHINE_COMMENT_MISSING");
const pkg = JSON.parse(m[1]);
await fs.writeFile(path.join(OUT, "package.json"), `${JSON.stringify(pkg, null, 2)}\n`, "utf8");
const seg = pkg.segments?.[0] || {};
const imgPrompt = String(seg.storyboard_image_prompt || "");
const annotationHint = ["注释", "标签条", "左上角", "格号"].filter((k) => imgPrompt.includes(k));
console.log(JSON.stringify({ step: "llm", promptChars: imgPrompt.length, annotationHints: annotationHint }));

// ---- 2) generate
const key2 = `annot-img-${crypto.randomUUID()}`.replace(/[^a-zA-Z0-9_-]/gu, "");
const res2 = await fetch(`${origin}/api/image/generate`, {
  method: "POST",
  headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "x-idempotency-key": key2 },
  signal: AbortSignal.timeout(600_000),
  body: JSON.stringify({
    prompt: imgPrompt, modelId: "pm_PZ3hS353YQNbfRnz2_9Ro0aX",
    aspectRatio: "16:9", resolution: "2K",
    clientTraceId: key2, clientIdempotencyKey: key2,
    clientNodeTitle: "annotation-test", historySurface: "storyboard-workbench",
    strictSingleSubmit: true,
  }),
});
const raw = await res2.text();
await fs.writeFile(path.join(OUT, "image-response.txt"), raw, "utf8");
const urls = [...new Set([...raw.matchAll(/https?:\/\/[^\s"'\\<>]+?\.(?:png|jpe?g|webp)(?:\?[^\s"'\\<>]*)?/giu)].map((x) => x[0]))];
let savedName = null;
if (urls[0]) {
  const r = await fetch(urls[0], { signal: AbortSignal.timeout(120_000) });
  if (r.ok) {
    const buf = Buffer.from(await r.arrayBuffer());
    const ext = buf[0] === 0x89 ? "png" : buf[0] === 0xff ? "jpg" : buf.subarray(0, 4).toString() === "RIFF" ? "webp" : "bin";
    savedName = `annotated-segment01.${ext}`;
    await fs.writeFile(path.join(OUT, savedName), buf);
  }
}
console.log(JSON.stringify({
  step: "image", http: res2.status, urls: urls.length, idempotencyKey: key2,
  saved: savedName, head: raw.slice(0, 220),
}, null, 2));
