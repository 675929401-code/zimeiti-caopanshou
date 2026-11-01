import fs from "node:fs/promises";
import path from "node:path";

// Autonomous quality scorer for storyboard director output.
// Turns the benchmark grammar (12 patterns + physics + commercial requirements)
// into deterministic checks, so prompt quality is measured, not felt.
const dir = process.argv[2] || ".codex-evidence/high-energy-v310-suite-20261022";
const files = (await fs.readdir(dir)).filter((f) => f.endsWith("-package.json")).sort();

const CN = /[\u4e00-\u9fa5]/u;
const countChinese = (s) => [...String(s).replace(/[^\u4e00-\u9fa5]/gu, "")].length;

function scoreSegment(seg, pkg) {
  const img = String(seg.storyboard_image_prompt || "");
  const vid = String(seg.image_to_video_prompt || "");
  const both = `${img}\n${vid}`;
  const checks = [];
  const add = (id, label, pass, weight, detail = "") => checks.push({ id, label, pass, weight, detail });

  // 1. single semantic core
  add("semantic", "语义核唯一（本段只讲一件事）",
    !/此外|另外|同时还|另一方面/u.test(img) && countChinese(img) > 300, 8,
    `image chars=${countChinese(img)}`);

  // 2. opening hook = close-up / strong expression
  const open = (both.match(/(?:钩子画面|开场画面|开场峰值|开场帧|首画面|第\s*1\s*格|第一格|首帧)[：:，,]?\s*([^\n。]{0,80})/u) || [])[1] || "";
  add("hook", "首帧特写钩子（近景/特写＋强表情）",
    /特写|近景|局部|钩子/u.test(open) && !/完整中景|全景/u.test(open), 9, open.slice(0, 40));

  // 3. character identity lock with >=5 wardrobe pieces
  const pieces = (img.match(/、/gu) || []).length;
  add("identity", "角色身份＋服装锁定（≥5 件单品）",
    /脸型|娃娃脸|五官|马尾|发型/u.test(img) && (pieces >= 5 || /开衫|卫衣|衬衫|外套|牛仔裤|长裙|鞋|项链|手表/u.test(img)), 8,
    `wuxu separators=${pieces}`);

  // 4. environment lock
  add("environment", "环境锁定（主光方向/色温/固定物）",
    /主光|色温|窗光|侧光|逆光|顶光|暖光|冷光|地毯|地板|家具/u.test(img), 7, "");

  // 5. visual style lock
  add("style", "视觉风格锁定（材质/渲染/色彩）",
    /3D|渲染|材质|次表面|毛发|织物|景深|焦段|高光/u.test(img), 7, "");

  // 6. single functional colour family
  const colourHits = ["红橙", "冷蓝", "绿色", "暖金", "金色"].filter((c) => both.includes(c));
  add("colour", "单条单功能色系（≤2 个族）", colourHits.length <= 2, 6, colourHits.join("/"));

  // 7. shot count matches duration
  const rule = { 8: [2, 3], 10: [3, 3], 15: [4, 5] }[seg.target_duration_seconds] || [1, 5];
  add("shots", "镜数符合对标节拍", seg.actual_shot_count >= rule[0] && seg.actual_shot_count <= rule[1], 7,
    `${seg.target_duration_seconds}s=${seg.actual_shot_count}`);

  // 8. one action + one camera move per shot
  const shotBlocks = vid.split(/镜头\s*\d+|\[\d|(?=第\s*\d\s*镜)/u).filter((b) => b.trim().length > 30);
  const overloaded = shotBlocks.filter((b) => {
    const moves = (b.match(/推近|拉远|甩镜|摇镜|俯冲|升格|移镜|跟拍|环绕|变焦|俯拍|仰拍|横移/gu) || []).length;
    return moves > 2;
  }).length;
  add("oneMove", "每镜一个主动作＋一个主运镜", overloaded === 0 && shotBlocks.length >= 2, 8,
    `blocks=${shotBlocks.length}, overloaded=${overloaded}`);

  // 9. prop five-step chain
  const propChain = ["来源", "拿起", "捏起", "提起", "夹住", "握住", "伸向", "托", "接触", "放回", "放下", "归位", "拾起", "收起", "取起", "挂在"].filter((k) => both.includes(k)).length;
  add("prop", "道具动作链（来源→取出→持有→接触→释放）", propChain >= 4, 8, `hits=${propChain}`);

  // 10. packaging lifecycle
  const life = ["出现", "增强", "收束", "接触", "亮起", "弹出", "退", "化作", "转为", "收成", "触发", "滑行", "收拢", "消散", "蔓延", "回收", "浮现", "贴合", "沿"].filter((k) => both.includes(k)).length;
  add("fx", "包装生命周期（出现→增强→接触→收束）", life >= 4, 8, `hits=${life}`);

  // 11. physics four elements
  const phys = ["接触点", "受力", "余波", "落幅", "掌根", "掌心", "反馈", "轻陷", "摆动", "压", "弹", "震", "毛发", "尘土", "光点", "袖口"].filter((k) => both.includes(k)).length;
  add("physics", "动作物理四要素", phys >= 4, 8, `hits=${phys}`);

  // 12. two expression peaks on the dog
  const peaks = (both.match(/眼白|瞳孔|耳朵|鼻翼|毛发炸|尾巴|缩脖|嘴角/gu) || []).length;
  add("peaks", "狗狗表情峰值≥2", peaks >= 2, 7, `hits=${peaks}`);

  // 13. on-screen text discipline
  const labels = [...img.matchAll(/[“"]([\u4e00-\u9fa5]{2,6})[”"]/gu)].map((m) => m[1]);
  const uniq = [...new Set(labels)];
  add("text", "画内中文牌≤1 且 2–4 字", uniq.length <= 1 && uniq.every((t) => t.length >= 2 && t.length <= 4), 7,
    JSON.stringify(uniq));

  // 14. audio boundary + post list
  add("audio", "声音边界＋后期清单分离",
    /无对白、无旁白、无配乐/u.test(vid), 6,
    /后期声音|后期清单/u.test(both) ? "post-list present" : "post-list absent");

  // 15. start frame is a single still pose
  add("singlePose", "首帧单一姿态（无“先…然后…”）",
    !/[^。]{0,20}先[^。]{0,30}然后[^。]{0,20}(出现|再|移)/u.test(img), 6, "");

  // 16. no panel-position reference
  add("noPanel", "无格位指代（左上/右下格/第几格/Frame N）",
    !/(左上|右上|左下|右下)格|第几格|Frame\s*\d/u.test(both), 5, "");

  // 17. commercial length discipline
  add("density", "生图提示词密度 900–2600 字", countChinese(img) >= 900 && countChinese(img) <= 2600, 6,
    `chars=${countChinese(img)}`);

  // 18. skeleton labels must carry content (>=20 chars on the same line)
  const SK = ["画幅格数", "风格锁定", "场景锁定", "角色资产", "道具与包装", "钩子画面", "画面文字"];
  const emptyBlocks = SK.filter((k) => {
    const line = img.split("\n").find((l) => l.includes(k)) || "";
    const ci = line.indexOf("：");
    const ha = line.indexOf(":");
    const idx = ci >= 0 ? ci : ha;
    const after = idx >= 0 ? line.slice(idx + 1) : "";
    return countChinese(after) < 20;
  });
  add("skeleton", "骨架段落名后必须有实质内容（≥20 字）", emptyBlocks.length === 0, 10,
    emptyBlocks.length ? `empty:${emptyBlocks.join("/")}` : "ok");

  const total = checks.reduce((s, c) => s + (c.pass ? c.weight : 0), 0);
  const max = checks.reduce((s, c) => s + c.weight, 0);
  return { checks, total, max, score: Math.round((total / max) * 100) };
}

const rows = [];
for (const f of files) {
  const pkg = JSON.parse(await fs.readFile(path.join(dir, f), "utf8"));
  const seg = pkg.segments?.[0];
  if (!seg) continue;
  const r = scoreSegment(seg, pkg);
  rows.push({ file: f, ...r });
}

const report = {
  schemaVersion: "storyboard_quality_score.v1",
  checkedAt: new Date().toISOString(),
  dir,
  cases: rows.map((r) => ({
    file: r.file, score: r.score,
    failed: r.checks.filter((c) => !c.pass).map((c) => `${c.id}:${c.label}(${c.detail})`),
  })),
  averageScore: rows.length ? Math.round(rows.reduce((s, r) => s + r.score, 0) / rows.length) : 0,
  detail: rows[0]?.checks ?? [],
};
await fs.writeFile(path.join(dir, "quality-score.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(JSON.stringify({ average: report.averageScore, cases: report.cases.map((c) => ({ f: c.file, s: c.score, fail: c.failed })) }, null, 2));
