import crypto from "node:crypto";
import fs from "node:fs/promises";

// v3.4.0 = v3.3.0 (baseline + 15 point edits) + Claude-authored performance layer as N18.
// The layer is added, not merged: nothing above N18 is rewritten.
const SRC = "prompts/storyboard-high-energy-v3.3.0-20261022.md";
const LAYER = ".codex-evidence/claude-performance-layer-20261022/performance-layer.md";
const OUT = "prompts/storyboard-high-energy-v3.4.0-20261022.md";

const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");

async function main() {
  const base = (await fs.readFile(SRC, "utf8")).replace(/^\uFEFF/u, "");
  let layer = (await fs.readFile(LAYER, "utf8")).replace(/^\uFEFF/u, "").trim();

  // Correction 1: "格与镜同义" contradicts the product contract (4-5 panels vs 3-4 shots).
  const badFrameShot = '本规范以"镜"为最小叙事单元，一镜对应故事板一格；格与镜同义。';
  const goodFrameShot = '本规范以"镜"为最小叙事单元。**格与镜不是一回事**：格是故事板上的画面峰值（按原有规则 4–5 格），镜是时间切片（按原有规则 8 秒 3 镜、10 秒 3 镜、15 秒 4 镜）。两者不必一一对应，一格可以落在某镜的中段。';
  if (layer.includes(badFrameShot)) layer = layer.replace(badFrameShot, goodFrameShot);

  // Correction 2: demote any heading levels inside the layer so it nests under N18.
  layer = layer.replace(/^##\s+/gmu, "### ");

  const header = `## N18 演绎层（对标反编译 · 只规范"怎么演"，不改变任何契约）

**优先级**：本节回答"这段文案怎么演成对标那样的画面"。与前文的演绎指导（包装生成器、语义镜头编舞器、高能语义包装强度层、精彩表演调度层）冲突时，**以本节为准**。

**边界（不可越过）**：
- 接收字段、输出格式（两个 text 代码框 + 末尾 HTML 注释机器包）、机器包 schema、时长档位与镜数规则、动画风格库 6 套、画质规则、中文牌写法、声音边界、参考图资产契约 —— **一律以上文条款为准，本节不得改动**。
- 本节只提供演绎方法：怎么切节拍、怎么定首帧、怎么配色、怎么套包装语法、怎么写动作链与收束。

`;

  const out = `${base.trimEnd()}\n\n${header}${layer}\n`;
  await fs.writeFile(OUT, out, "utf8");

  const baseLines = base.split("\n");
  const outLines = out.split("\n");
  let changed = 0;
  for (let i = 0; i < Math.max(baseLines.length, outLines.length); i += 1) {
    if (baseLines[i] !== outLines[i]) changed += 1;
  }

  console.log(JSON.stringify({
    src: { path: SRC, chars: base.length, sha: sha(base) },
    layer: { chars: layer.length },
    out: { path: OUT, chars: out.length, sha: sha(out) },
    changedLineCount: changed,
    grewBy: out.length - base.length,
    corrections: ["frame!=shot", "heading demoted to ###"],
  }, null, 2));
}
main().catch((e) => { console.error("BUILD_FAILED:", e.message); process.exit(1); });
