import crypto from "node:crypto";
import fs from "node:fs/promises";

// v3.5.0 = keep functional sections from v3.3.0 + drop explanatory methodology + insert N18 handbook.
const SRC = "prompts/storyboard-high-energy-v3.3.0-20261022.md";
const HANDBOOK = ".codex-evidence/performance-handbook-20261022/N18-handbook.md";
const OUT = "prompts/storyboard-high-energy-v3.5.0-20261022.md";

const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");

// sections dropped because N18 handbook replaces them (pure methodology / explanation)
const DROP = new Set([
  "行业标杆十维门禁",
  "四层控制架构",
  "证据纪律",
  "对标画面形态锁定",
  "分镜文字说明层",
  "制作语法三层",
  "语义包装方法论",
  "高能语义包装强度层",
  "精彩表演调度层",
  "指令索引与遵从度锚点",
  "核心工作流",
  "包装生成器",
  "语义镜头编舞器",
  "镜头执行线",
  "视频时间线母版",
  "视频演出生成器",
  "输出前自检",
  "N10 对标反推证据（内部依据，不写进输出）",
  "N12 3D 三套圣经与双编译（决定画面是否“耐看”的那一层）",
  "N17 默认角色资产锁定（用户未指定时逐字执行）",
  "N8 交付前机器自检（与校验器同源）",
]);

async function main() {
  const lines = (await fs.readFile(SRC, "utf8")).replace(/^\uFEFF/u, "").split(/\r?\n/u);
  const handbook = (await fs.readFile(HANDBOOK, "utf8")).replace(/^\uFEFF/u, "").trim();

  const blocks = [];
  let cur = { h: "（前言）", lines: [] };
  for (const l of lines) {
    if (/^#{1,2}\s/u.test(l)) { blocks.push(cur); cur = { h: l.replace(/^#+\s*/u, "").trim(), lines: [l] }; }
    else cur.lines.push(l);
  }
  blocks.push(cur);

  const kept = [];
  const dropped = [];
  for (const b of blocks) {
    if (b.h !== "（前言）" && DROP.has(b.h)) dropped.push(b.h);
    else kept.push(b);
  }

  const body = kept.map((b) => b.lines.join("\n")).join("\n").trimEnd();
  const out = `${body}\n\n${handbook}\n`;
  await fs.writeFile(OUT, out, "utf8");

  console.log(JSON.stringify({
    src: { chars: lines.join("\n").length, sha: sha(lines.join("\n")) },
    droppedSections: dropped.sort(),
    keptSectionCount: kept.length,
    handbookChars: handbook.length,
    out: { path: OUT, chars: out.length, sha: sha(out) },
  }, null, 2));
}
main().catch((e) => { console.error("BUILD_FAILED:", e.message); process.exit(1); });
