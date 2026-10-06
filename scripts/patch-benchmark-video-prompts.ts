import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";

const storageStatePath = ".tmp-e2e/benchmark-director-v8-live/storage-state.json";
const storageKey = "ai-creation-studio-graph-v1";
const replacements = new Map<string, string>([
  ["分镜07 · 视频提示词", "从参考图里阿麦僵住回望的姿态直接开始。绿色骷髅雾体突然向前翻卷逼近约半个身位，阿麦立刻全身一震：双眼明显睁大、耳朵紧贴脑后，前爪同时弹离地面再向后落下，后腿连续蹬地急退两小步，重心压低，颈背到尾根的长毛清楚竖起，尾巴从低垂迅速夹紧到两条后腿之间。它最终缩成低伏弓背姿态，张嘴短促喘息并惊恐盯住骷髅雾体。镜头保持侧后方低机位，只沿后退方向短距离跟进；紫色轮廓光随炸毛短促增强后稳定。保留雾气翻卷、四爪蹬地、毛发窸窣和短促鼻息声。"],
  ["分镜09 · 视频提示词", "从参考图里鼻尖对准单枚浅黄色苹果丁的姿态直接开始。阿麦先轻嗅一次，再低下嘴筒只咬掉苹果丁靠近自己的一个小角，不把苹果丁叼起；剩余苹果丁始终留在地毯原位，保持约1.5厘米、浅象牙黄色、六面方块，始终明显小于犬鼻，不放大、不增殖、不变成圆形或整颗水果。阿麦抬头做一次小幅咀嚼，随即放松垂耳、肩背和前爪重心，眼神转柔和，羽状长尾快速横扫右侧沙发边缘并擦动绒毛。镜头在犬身高度从头部向尾巴短距离横移，最后稳定停在放松侧脸和轻摆尾巴上。保留轻脆咬食、咀嚼和尾毛擦沙发声。"],
]);

async function main() {
  const storage = JSON.parse(await readFile(storageStatePath, "utf8")) as {
    origins?: Array<{ origin: string; localStorage: Array<{ name: string; value: string }> }>;
  };
  const origin = storage.origins?.find((item) => item.origin === "http://127.0.0.1:5000");
  assert.ok(origin, "恢复文件中没有本地画布数据");
  const entry = origin.localStorage.find((item) => item.name === storageKey);
  assert.ok(entry, "恢复文件中没有画布图");
  const graph = JSON.parse(entry.value) as { nodes?: Array<{ data: { title: string; prompt?: string; outputText?: string } }> };
  let updated = 0;
  for (const node of graph.nodes || []) {
    const replacement = replacements.get(node.data.title);
    if (!replacement) continue;
    node.data.prompt = replacement;
    node.data.outputText = replacement;
    updated += 1;
  }
  assert.equal(updated, replacements.size, `只更新了${updated}/${replacements.size}条提示词`);
  entry.value = JSON.stringify(graph);
  await writeFile(storageStatePath, `${JSON.stringify(storage, null, 2)}\n`, "utf8");
  console.log(`已更新${updated}条画布视频提示词`);
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
