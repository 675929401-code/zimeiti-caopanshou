import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

// v4.0 verification: after a 77% shrink, does the package still parse, does the
// fixed skeleton survive, and are the E/S vocabulary codes actually used?
const origin = String(process.env.LOCAL_NAV_ORIGIN || "").replace(/\/+$/u, "");
const token = String(process.env.LOCAL_NAV_ADMIN_TOKEN || "").trim();
assert.equal(origin, "http://127.0.0.1:5000", "EXACT_LOCAL_RUNTIME_REQUIRED");
assert.ok(token, "LOCAL_NAV_ADMIN_TOKEN_REQUIRED");

const OUT_DIR = path.resolve(".codex-evidence/high-energy-v372-consistency-20261022");
const cases = [
  { id: "run1-body-10s", duration: "10秒版：每段3-4个镜头",
    script: "1.【很多主人以为柯基屁股圆就是可爱，其实那是超重信号。从正上方拍一张俯视图，腰线两侧凹进去才健康。】" },
  { id: "run2-body-10s", duration: "10秒版：每段3-4个镜头",
    script: "1.【很多主人以为柯基屁股圆就是可爱，其实那是超重信号。从正上方拍一张俯视图，腰线两侧凹进去才健康。】" },
];
const SKELETON = ["画幅格数", "风格锁定", "场景锁定", "角色资产", "道具与包装", "钩子画面", "画面文字"];
const results = [];

for (const c of cases) {
  const key = `v400-${c.id}-${crypto.randomUUID()}`.replace(/[^a-zA-Z0-9_-]/gu, "");
  const res = await fetch(`${origin}/api/llm`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "Idempotency-Key": key },
    cache: "no-store", signal: AbortSignal.timeout(300_000),
    body: JSON.stringify({
      client_request_id: key,
      messages: [{ role: "user", content: [
        "分段文案：", c.script, "",
        `分段时长：${c.duration}`, "视频比例：16:9",
        "动画风格：皮克斯式高能3D宠物科普动画",
        "主人性别：文案优先，未指定默认女主人",
        "狗狗品种：文案优先，未指定默认柯基",
        "特殊备注：无", "视觉资产模式：普通模式",
      ].join("\n") }],
      agentId: "agent-1786843330392-emdjv2", agentName: "3D故事导演｜高能版",
      stream: false, maxContextRounds: 0, enable_web_search: false,
    }),
  });
  const payload = await res.json().catch(() => ({}));
  assert.ok(res.ok, `${c.id}:HTTP_${res.status}`);
  const content = String(payload?.choices?.[0]?.message?.content || "");
  await fs.mkdir(OUT_DIR, { recursive: true });
  await fs.writeFile(path.join(OUT_DIR, `${c.id}-raw.txt`), content, "utf8");
  const m = content.match(/<!--\s*storyboard_director_output:v1\s*([\s\S]*?)-->/i);
  let pkg = null;
  if (m) { try { pkg = JSON.parse(m[1]); } catch {} }
  if (pkg) await fs.writeFile(path.join(OUT_DIR, `${c.id}-package.json`), `${JSON.stringify(pkg, null, 2)}\n`, "utf8");

  const seg = (pkg?.segments || [])[0] || {};
  const img = String(seg.storyboard_image_prompt || "");
  const vid = String(seg.image_to_video_prompt || "");
  const both = `${img}\n${vid}`;
  const blocks = SKELETON.map((k) => {
    const line = img.split("\n").find((l) => l.includes(k)) || "";
    const i = line.indexOf("：");
    return { k, len: i >= 0 ? line.slice(i + 1).trim().length : 0 };
  });
  const eCodes = [...new Set((both.match(/E\d{1,2}/gu) || []))];
  const sCodes = [...new Set((vid.match(/S\d/gu) || []))];
  const colours = ["红橙", "红", "紫", "绿", "冷蓝", "蓝", "金", "暖"].filter((x) => both.includes(x));

  results.push({
    id: c.id,
    packageFound: Boolean(pkg),
    shots: seg.actual_shot_count ?? null,
    duration: seg.target_duration_seconds ?? null,
    skeletonMissing: blocks.filter((b) => b.len < 20).map((b) => b.k),
    eCodes, sCodes, colours,
    lifeCycle: ["出现", "增强", "碰撞", "收束"].filter((w) => both.includes(w)),
    audioBoundary: /无对白、无旁白、无配乐/u.test(vid),
  });
  console.log(JSON.stringify({ id: c.id, pkg: Boolean(pkg), e: eCodes.length, s: sCodes.length, life: results.at(-1).lifeCycle.length, miss: results.at(-1).skeletonMissing.length }));
}

const report = {
  schemaVersion: "high_energy_v372_consistency.v1",
  checkedAt: new Date().toISOString(),
  summary: {
    allParsed: results.every((r) => r.packageFound),
    anySkeletonGap: results.some((r) => r.skeletonMissing.length > 0),
    anyECodes: results.every((r) => r.eCodes.length >= 2),
    anySCodes: results.some((r) => r.sCodes.length >= 1),
    anyFullLifecycle: results.every((r) => r.lifeCycle.length >= 3),
  },
  results,
};
await fs.writeFile(path.join(OUT_DIR, "report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(JSON.stringify(report.summary, null, 2));
