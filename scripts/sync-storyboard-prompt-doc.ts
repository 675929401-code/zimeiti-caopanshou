import { readFile, writeFile } from "node:fs/promises";
import { STORYBOARD_AGENT_PROMPT } from "../src/lib/storyboard-workbench";

async function main() {
  const documentPath = "docs/10秒故事板导演智能体提示词-v2.md";
  const document = await readFile(documentPath, "utf8");
  const startMarker = "```text\n";
  const start = document.indexOf(startMarker);
  const end = document.indexOf("\n```", start + startMarker.length);

  if (start < 0 || end <= start) {
    throw new Error("PROMPT_FENCE_NOT_FOUND");
  }

  const normalizedPrompt = STORYBOARD_AGENT_PROMPT.replace(/\r\n/gu, "\n");
  const documentedPrompt = document.slice(start + startMarker.length, end).replace(/\r\n/gu, "\n");
  const checkOnly = process.argv.includes("--check");

  if (checkOnly) {
    if (documentedPrompt !== normalizedPrompt) throw new Error("STORYBOARD_PROMPT_DOC_DRIFT");
    console.log(JSON.stringify({ synced: true, checked: true, promptLength: normalizedPrompt.length }));
    return;
  }

  const next = document.slice(0, start + startMarker.length)
    + normalizedPrompt
    + document.slice(end);

  await writeFile(documentPath, next, "utf8");
  console.log(JSON.stringify({ synced: true, checked: false, promptLength: normalizedPrompt.length }));
}

void main();
