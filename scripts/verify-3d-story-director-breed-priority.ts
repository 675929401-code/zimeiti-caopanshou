import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { formatPresetFieldValue } from "../src/components/preset-dialog";
import type { PresetField } from "../src/types/coze";

const expectedPromptSha = "289279c5bc8dd31ed6b4af8688f2236f53c9a63dc20709a8d446f30c9668e641";
const promptPath = resolve("prompts/storyboard-voiceover-cinematic-v4.3.2.md");
const sha256 = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");

const scriptField: PresetField = {
  id: "segmented_script",
  label: "分段文案",
  type: "textarea",
  placeholder: "",
  required: true,
  options: [],
  order: 0,
  sendLabel: true,
  sendText: "segmented_script",
};
const breedField: PresetField = {
  id: "dog_breed",
  label: "狗狗品种",
  type: "select",
  placeholder: "不选：按文案识别犬种",
  required: false,
  options: ["柯基", "金毛", "哈士奇"],
  order: 1,
  sendLabel: true,
  sendText: "dog_breed",
};

function compileValues(values: Record<string, string>) {
  return Object.fromEntries(
    [scriptField, breedField]
      .map((field) => [field.id, formatPresetFieldValue(field, values[field.id] || "", true)] as const)
      .filter(([, value]) => Boolean(value)),
  );
}

async function main() {
  const blankBreed = compileValues({
    segmented_script: "1. 一只哈士奇趴在玄关，主人弯腰观察它。",
    dog_breed: "",
  });
  assert.equal(blankBreed.dog_breed, undefined, "犬种留空时仍被发送");
  assert.match(blankBreed.segmented_script, /哈士奇/u, "文案犬种语义被丢失");

  const selectedBreed = compileValues({
    segmented_script: "1. 一只哈士奇趴在玄关，主人弯腰观察它。",
    dog_breed: "金毛",
  });
  assert.equal(selectedBreed.dog_breed, "dog_breed：金毛", "明确选择的犬种未发送");

  const prompt = (await readFile(promptPath, "utf8")).replace(/^\uFEFF/u, "").trimEnd();
  assert.equal(sha256(prompt), expectedPromptSha, "电影叙事v4.3.2提示词SHA异常");
  assert.match(prompt, /dog_breed`收到具体犬种时[\s\S]*用户对主角狗的主动覆盖/u);
  assert.match(prompt, /下拉具体选择 > 特殊备注明确犬种 > 原文主角犬种 > 项目兜底/u);
  assert.match(prompt, /仅在下拉未选择、特殊备注没有明确犬种、原文也没有犬种线索时/u);
  assert.match(prompt, /若下拉、备注或原文给出其他犬种[\s\S]*不得回退为柯基/u);
  assert.match(prompt, /生成门禁：犬种设定冲突，请明确主角狗犬种或拆分文案/u);
  assert.doesNotMatch(prompt, /柯基保持真实四足比例/u, "风格模板仍硬编码柯基");

  console.log(JSON.stringify({
    status: "passed",
    blankBreedFieldOmitted: true,
    scriptBreedPreserved: "哈士奇",
    explicitBreedSent: "金毛",
    promptSha256: expectedPromptSha,
    priority: ["explicit-dropdown", "explicit-special-notes", "script-semantics", "project-fallback"],
    paidCalls: 0,
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : error);
  process.exitCode = 1;
});
