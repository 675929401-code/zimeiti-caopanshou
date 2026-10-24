import crypto from "node:crypto";
import fs from "node:fs/promises";

// v3.6.0 = v3.5.0 + soft-decoration pass. Load-bearing walls untouched.
const SRC = "prompts/storyboard-high-energy-v3.5.0-20261022.md";
const OUT = "prompts/storyboard-high-energy-v3.6.0-20261022.md";
const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");

const N16_OLD = `## N16 犬类表演边界（所有风格共用，不可越过）

始终保持犬类四足结构。不做招手、比划、握拳、双手抱物、直立行走、用爪子精细操作道具。情绪只通过眼白与瞳孔、耳朵、鼻尖与鼻翼、嘴型、毛发、重心、尾巴、前爪急停表达。`;

const N16_NEW = `## N16 犬类表演边界（四足结构不动，表情放开）

**结构不变**：始终保持犬类四足结构；不做招手、比划、握拳、双手抱物、直立行走、用爪子精细操作道具。

**表情允许拟人**：对标账号的狗会得意、会委屈、会翻白眼、会撇嘴、会"说话式"张嘴、会叹气、会心虚躲闪。这些是画面情绪的发动机，必须用。

可用表情清单：眼睛（睁大／眯起／斜视／翻白／含泪光）、眉毛（上挑／皱起／下垂）、嘴角（上扬得意／下撇委屈／抿紧）、耳朵（竖起／后压／一前一后）、鼻子（皱起／抽动）、舌头（伸出／舔嘴／收回）、毛发（炸起／贴伏）、尾巴（快摇／夹低／僵直）、重心（前压／后缩／瘫坐）。

**禁止的是人形结构，不是夸张表情。**`;

const APPEND = `
### 十、画面质感与综艺包装（决定"像不像对标"的那一层）

**1. 光色基调**
默认暖调：主光色温 5000–5400K；饱和度偏高但不过曝；对比中等偏高，保留面部与毛发细节；空气干净少颗粒。寒冷、危险、医疗类文案才允许整体压冷，且只压一档。

**2. 包装分三级，按情绪选**
- **检查级**（证据、测量、护理）：贴体轮廓、放大窗、刻度、温度条，冷蓝或白色为主。
- **情绪级**（关系、陪伴、期待）：柔光晕、光斑、心形环、距离连线、慢速粒子，暖金或粉色为主。
- **高潮级**（揭示、爽感、真相、转折）：聚光灯锥、舞台灯、圆形舞台、光柱、粒子爆发、放射线，金／粉／紫为主。

**3. 允许升级**：一段内可以从检查级升到高潮级，作为情绪顶点；禁止从高潮级回落到检查级（会泄气）。

**4. 对标爆款帧的共性**：大量使用高潮级包装（聚光、圆台、放射线）。所以每段至少要有一次"光效明显变化"，不能全段平光。

**5. 画面只演一个动作，信息交给字幕**。不要为了"讲清楚"在画面里堆刻度、箭头、说明块、多行文字。画面负责情绪与证据，字幕负责信息。

**6. 五条气质线（每段至少满足三条）**
① 暖调光；② 高饱和；③ 夸张大眼与丰富表情；④ 明显的综艺光效（聚光/光斑/放射/舞台）；⑤ 主角（狗或人）占画面一半以上。

**7. 构图偏好**：对标偏爱"主角怼近 + 大眼直视镜头"的压迫感构图。允许主体占据画面 50%–70%，头发/耳朵/臀部可以出画，不必每格都留全身安全区；只在结论格给完整构图与安全区。
`;

async function main() {
  const base = (await fs.readFile(SRC, "utf8")).replace(/^\uFEFF/u, "");
  if (!base.includes(N16_OLD)) throw new Error("N16_ANCHOR_MISSING");
  let out = base.replace(N16_OLD, N16_NEW);
  out = `${out.trimEnd()}\n${APPEND}`;
  await fs.writeFile(OUT, out, "utf8");

  const bl = base.split("\n"), ol = out.split("\n");
  let changed = 0;
  for (let i = 0; i < Math.max(bl.length, ol.length); i += 1) if (bl[i] !== ol[i]) changed += 1;

  console.log(JSON.stringify({
    src: { chars: base.length, sha: sha(base) },
    out: { path: OUT, chars: out.length, sha: sha(out) },
    grewBy: out.length - base.length,
    changedLineCount: changed,
    edits: ["N16 expression liberalized", "N18 §10 soft-decoration added"],
  }, null, 2));
}
main().catch((e) => { console.error("BUILD_FAILED:", e.message); process.exit(1); });
