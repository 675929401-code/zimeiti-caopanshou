import type { PromptImportItem, PromptImportResult } from "@/lib/studio-canvas-types";

const TAG_PATTERN = /【\s*(图片|生图|视频)提示词\s*】/g;
const NUMBERED_PATTERN = /^\s*(?:第?\d+\s*[.、):：]|[-*]\s+)(.+)$/;

function cleanInput(input: string): string {
  return input
    .replace(/\r\n?/g, "\n")
    .replace(/^```[^\n]*\n?/gm, "")
    .replace(/^```\s*$/gm, "")
    .trim();
}

function parseTagged(text: string): PromptImportResult | null {
  const matches = [...text.matchAll(TAG_PATTERN)];
  if (matches.length === 0) return null;

  const items: PromptImportItem[] = [];
  const warnings: string[] = [];
  let current: PromptImportItem | null = null;

  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index];
    const kind = match[1];
    const start = (match.index ?? 0) + match[0].length;
    const end = matches[index + 1]?.index ?? text.length;
    const value = text.slice(start, end).trim();

    if (kind === "图片" || kind === "生图") {
      if (current?.imagePrompt) items.push(current);
      current = { imagePrompt: value, videoPrompt: "" };
      if (!value) warnings.push(`第 ${items.length + 1} 组缺少图片提示词`);
      continue;
    }

    if (!current) {
      warnings.push("检测到没有对应图片提示词的视频提示词，已忽略");
      continue;
    }
    current.videoPrompt = value;
  }

  if (current?.imagePrompt) items.push(current);
  return { items, mode: "tagged", warnings };
}

function parseNumbered(text: string): PromptImportResult | null {
  const lines = text.split("\n");
  const groups: string[] = [];
  let current = "";
  let matched = 0;

  for (const line of lines) {
    const numbered = line.match(NUMBERED_PATTERN);
    if (numbered) {
      matched += 1;
      if (current.trim()) groups.push(current.trim());
      current = numbered[1].trim();
    } else if (current && line.trim()) {
      current += `\n${line.trim()}`;
    }
  }

  if (current.trim()) groups.push(current.trim());
  if (matched < 2) return null;

  return {
    items: groups.map((imagePrompt) => ({ imagePrompt, videoPrompt: "" })),
    mode: "numbered",
    warnings: [],
  };
}

function resultFromParts(
  parts: string[],
  mode: PromptImportResult["mode"],
): PromptImportResult {
  return {
    items: parts
      .map((part) => part.trim())
      .filter(Boolean)
      .map((imagePrompt) => ({ imagePrompt, videoPrompt: "" })),
    mode,
    warnings: [],
  };
}

export function parsePromptBatch(input: string): PromptImportResult {
  const text = cleanInput(input);
  if (!text) return { items: [], mode: "single", warnings: ["没有可导入的提示词"] };

  const tagged = parseTagged(text);
  if (tagged) return tagged;

  const numbered = parseNumbered(text);
  if (numbered) return numbered;

  if (/^\s*---+\s*$/m.test(text)) {
    return resultFromParts(text.split(/^\s*---+\s*$/m), "separated");
  }

  const paragraphs = text.split(/\n\s*\n+/).filter((part) => part.trim());
  if (paragraphs.length > 1) return resultFromParts(paragraphs, "paragraphs");

  const lines = text.split("\n").map((line) => line.trim()).filter(Boolean);
  if (lines.length > 1) return resultFromParts(lines, "lines");

  return resultFromParts([text], "single");
}
