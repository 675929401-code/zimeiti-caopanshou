import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";

const baseUrl = process.env.CANVAS_TEST_BASE_URL || "http://127.0.0.1:5000";
const storageStatePath = ".tmp-e2e/benchmark-director-v8-live/storage-state.json";
const outputPath = ".tmp-e2e/benchmark-director-v8-live/images/shot-09-repaired.png";
const graphStorageKey = "ai-creation-studio-graph-v1";

type StoredNode = {
  data: {
    kind: string;
    title: string;
    prompt?: string;
    outputText?: string;
    outputUrl?: string;
    history?: Array<{ id: string; outputUrl: string; createdAt: string }>;
  };
};

async function jsonRequest<T>(url: string, init: RequestInit = {}) {
  const response = await fetch(url, init);
  const payload = await response.json().catch(() => ({})) as T & { error?: string };
  if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
  return payload;
}

async function main() {
  const storage = JSON.parse(await readFile(storageStatePath, "utf8")) as {
    origins?: Array<{ origin: string; localStorage: Array<{ name: string; value: string }> }>;
  };
  const origin = storage.origins?.find((item) => item.origin === baseUrl);
  assert.ok(origin, "恢复文件中没有本地画布数据");
  const graphEntry = origin.localStorage.find((item) => item.name === graphStorageKey);
  assert.ok(graphEntry, "恢复文件中没有画布图");
  const graph = JSON.parse(graphEntry.value) as { nodes?: StoredNode[] };
  const nodes = graph.nodes || [];
  const imageNode = nodes.find((node) => node.data.kind === "image" && node.data.title.startsWith("分镜09 · 自动关键帧"));
  const promptNode = nodes.find((node) => node.data.kind === "text" && node.data.title === "分镜09 · 参考图提示词");
  assert.ok(imageNode?.data.outputUrl, "分镜09缺少待修复图片");
  const originalPrompt = promptNode?.data.outputText || promptNode?.data.prompt || "";
  assert.ok(originalPrompt, "分镜09缺少参考图提示词");

  const session = await jsonRequest<{ token?: string }>(`${baseUrl}/api/auth/dev-session`, {
    headers: { "x-local-workbench": "ai-creation-studio-local" },
  });
  assert.ok(session.token, "本地验收会话不可用");
  const headers = { Authorization: `Bearer ${session.token}`, "Content-Type": "application/json" };
  const prompt = `${originalPrompt}\n局部编辑指令：删除画面左下角现有苹果块或任何大块水果。只在阿麦鼻尖正下方保留一枚约1.5厘米见方、明显小于犬鼻的完全去皮去核苹果丁，浅象牙黄色，六个平整切面，微湿苹果纤维；不要红色果皮，不要圆弧轮廓，不要果核、籽或果柄。画面里不得出现第二块食物、整颗或半颗水果、梨、土豆、斑点圆果或葡萄。保持原图金毛犬的天然四足结构、身份、姿态、客厅、沙发、机位、构图、光线和16:9横屏不变，只替换错误水果。`;
  const generated = await jsonRequest<{ images?: Array<{ url: string }> }>(`${baseUrl}/api/bridge/image/generate`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      prompt,
      mode: "local",
      modelId: "gemini-3-1-flash-image-chA",
      aspectRatio: "16:9",
      resolution: "1K",
      referenceImageUrls: [imageNode.data.outputUrl],
      referenceUsage: "general",
    }),
  });
  const generatedUrl = generated.images?.[0]?.url;
  assert.ok(generatedUrl, "图片模型没有返回修复结果");
  const persisted = await jsonRequest<{ url?: string }>(`${baseUrl}/api/bridge/image/persist`, {
    method: "POST",
    headers,
    body: JSON.stringify({ url: generatedUrl }),
  });
  assert.ok(persisted.url, "修复图片登记失败");

  const oldUrl = imageNode.data.outputUrl;
  imageNode.data.outputUrl = persisted.url;
  imageNode.data.history = [
    { id: randomUUID(), outputUrl: persisted.url, createdAt: new Date().toISOString() },
    ...(imageNode.data.history || []),
  ];
  graphEntry.value = JSON.stringify(graph);
  await writeFile(storageStatePath, `${JSON.stringify(storage, null, 2)}\n`, "utf8");

  const isExternalUrl = persisted.url.startsWith("http");
  const response = await fetch(isExternalUrl ? persisted.url : `${baseUrl}${persisted.url}`, isExternalUrl ? {} : {
    headers: { Authorization: `Bearer ${session.token}` },
  });
  assert.ok(response.ok, `修复图片下载失败：HTTP ${response.status}`);
  await mkdir(".tmp-e2e/benchmark-director-v8-live/images", { recursive: true });
  await writeFile(outputPath, Buffer.from(await response.arrayBuffer()));
  await writeFile(
    ".tmp-e2e/benchmark-director-v8-live/images/shot-09-repair-report.json",
    `${JSON.stringify({ oldUrl, newUrl: persisted.url, outputPath, prompt }, null, 2)}\n`,
    "utf8",
  );
  console.log(JSON.stringify({ oldUrl, newUrl: persisted.url, outputPath }, null, 2));
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
