"use client";

import { readBrowserWorkbenchIdentity, workbenchUserStorageKey } from "@/lib/workbench-user-storage";

export const VIDEO_TASK_TRANSFER_KEY = "agent_hub_video_task_transfer_v1";
export const VIDEO_TASK_TRANSFER_EVENT = "agent-hub-video-task-transfer";
export const VIDEO_TASK_DRAFT_KEY = "agent_hub_video_task_draft_v1";
export const VIDEO_TASK_DRAFT_TTL_MS = 2 * 60 * 1000;
export const VIDEO_SMART_IMPORT_KEY = "video_smart_import_text";

export type VideoTaskTransferSource = "chat-code" | "chat-image" | "chat-message" | "manual";

export interface VideoTaskTransferItem {
  order: number;
  prompt?: string;
  imageUrl?: string;
  label?: string;
  title?: string;
  source?: VideoTaskTransferSource;
}

export interface VideoTaskTransferPayload {
  version: 1;
  ownerUserId?: string;
  mode: "single" | "batch";
  items: VideoTaskTransferItem[];
  createdAt: number;
}

const CHINESE_NUMBERS: Record<string, number> = {
  一: 1,
  二: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
  十: 10,
};

const CODE_LANGS = new Set(["js", "jsx", "ts", "tsx", "python", "py", "css", "html", "json", "bash", "shell", "sql", "yaml", "yml", "xml"]);
const VIDEO_PROMPT_HINT_RE = /\u65b9\u6848|\u5206\u6bb5|\u53c2\u8003\u56fe|\u89c6\u9891\u63d0\u793a\u8bcd|\u56fe\u751f\u89c6\u9891|\u6587\u751f\u89c6\u9891|\u753b\u9762|\u955c\u5934|\u8fd0\u955c|\u9996\u5e27|\u5c3e\u5e27/i;
const NORMAL_CHINESE_NUMBERS: Record<string, number> = {
  "\u4e00": 1,
  "\u4e8c": 2,
  "\u4e09": 3,
  "\u56db": 4,
  "\u4e94": 5,
  "\u516d": 6,
  "\u4e03": 7,
  "\u516b": 8,
  "\u4e5d": 9,
  "\u5341": 10,
};

function parseChineseOrderChar(value: string | undefined): number | undefined {
  if (!value) return undefined;
  return CHINESE_NUMBERS[value] ?? NORMAL_CHINESE_NUMBERS[value];
}
const VIDEO_PROMPT_RE = /段落|图片|图像|任务|卡片|镜头|分镜|画面|场景|视频|时长|时间轴|风格|比例|提示词|参考图|首帧|尾帧|Prompt|Shot|Scene|camera|lighting|composition|subject|frame|visual|duration|aspect/i;

export function normalizeVideoTaskOrder(value: unknown, fallback = 1): number {
  const num = Number(value);
  if (Number.isFinite(num) && num > 0) return Math.min(40, Math.max(1, Math.floor(num)));
  return Math.min(40, Math.max(1, Math.floor(fallback || 1)));
}

export function inferVideoTaskOrder(text: string, fallback = 1): number {
  const normalized = (text || "").slice(0, 300);
  const planMatch = normalized.match(/(?:\u65b9\u6848|\u5206\u6bb5)\s*[\[\u3010\uff08(]?\s*(\d{1,2})/i);
  if (planMatch) return normalizeVideoTaskOrder(planMatch[1], fallback);

  const planCnMatch = normalized.match(/(?:\u65b9\u6848|\u5206\u6bb5)\s*[\[\u3010\uff08(]?\s*([\u4e00\u4e8c\u4e09\u56db\u4e94\u516d\u4e03\u516b\u4e5d\u5341])/);
  if (planCnMatch) return normalizeVideoTaskOrder(parseChineseOrderChar(planCnMatch[1]), fallback);

  const digitMatch = normalized.match(/(?:\u6bb5\u843d|\u56fe\u7247|\u56fe\u50cf|\u4efb\u52a1|\u5361\u7247|\u7b2c|task|part|segment|section)\s*[\[\u3010\uff08(]?\s*(\d{1,2})/i);
  if (digitMatch) return normalizeVideoTaskOrder(digitMatch[1], fallback);

  const cnMatch = normalized.match(/(?:\u6bb5\u843d|\u56fe\u7247|\u56fe\u50cf|\u4efb\u52a1|\u5361\u7247|\u7b2c)\s*([\u4e00\u4e8c\u4e09\u56db\u4e94\u516d\u4e03\u516b\u4e5d\u5341])/);
  if (cnMatch) return normalizeVideoTaskOrder(parseChineseOrderChar(cnMatch[1]), fallback);

  const shotMatch = normalized.match(/(?:\u955c\u5934|\u5206\u955c|scene|shot)\s*[\[\u3010\uff08(]?\s*(\d{1,2})/i);

  const leadingMatch = normalized.match(/^\s*0?(\d{1,2})(?=[.\-_:：、)）\]】\s]|$)/);
  if (leadingMatch) return normalizeVideoTaskOrder(leadingMatch[1], fallback);

  const compactDigitMatch = normalized.match(/(?:^|[^\d])0?(\d{1,2})\s*(?=\u6bb5|\u5f20|\u53f7|\u96c6|\u5361|\u56fe|\u4efb\u52a1)/);
  if (compactDigitMatch) return normalizeVideoTaskOrder(compactDigitMatch[1], fallback);

  if (shotMatch) return normalizeVideoTaskOrder(shotMatch[1], fallback);

  return normalizeVideoTaskOrder(fallback, fallback);
}

export function sanitizeVideoPrompt(text: string): string {
  return (text || "")
    .replace(/^\s*```[\w-]*\s*/i, "")
    .replace(/\s*```\s*$/i, "")
    .replace(/^\s*:::(?:prompt|text|copy|视频提示词|文生视频)[^\n]*\n?/gim, "")
    .replace(/^\s*:::\s*$/gm, "")
    .replace(/\b(?:复制|一键复制|复制代码|复制提示词|发送到视频|发到视频|发送)\b/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function isLikelyVideoPrompt(text: string, language?: string): boolean {
  const lang = (language || "").toLowerCase();
  if (CODE_LANGS.has(lang)) return false;
  const clean = sanitizeVideoPrompt(text);
  if (clean.length < 20) return false;
  return VIDEO_PROMPT_RE.test(clean) || VIDEO_PROMPT_HINT_RE.test(clean);
}

export function makeVideoTaskTransferPayload(
  items: VideoTaskTransferItem[],
  mode: "single" | "batch" = "single",
): VideoTaskTransferPayload {
  const normalizedItems = items
    .map((item, index) => ({
      ...item,
      order: normalizeVideoTaskOrder(item.order, index + 1),
      prompt: item.prompt ? sanitizeVideoPrompt(item.prompt) : undefined,
    }))
    .filter((item) => item.prompt || item.imageUrl);

  return {
    version: 1,
    mode,
    items: normalizedItems,
    createdAt: Date.now(),
  };
}

export function clearLegacyVideoTaskTransfer(): void {
  if (typeof window === "undefined") return;
  const identity = readBrowserWorkbenchIdentity();
  const bases = [VIDEO_TASK_TRANSFER_KEY, VIDEO_TASK_DRAFT_KEY, VIDEO_SMART_IMPORT_KEY];
  try {
    for (const base of bases) {
      window.localStorage.removeItem(base);
      window.sessionStorage.removeItem(base);
      if (identity) window.localStorage.removeItem(workbenchUserStorageKey(base, identity.userId));
    }
  } catch {
    // Legacy cleanup must not block an explicit handoff.
  }
}

export function dispatchVideoTaskTransfer(payload: VideoTaskTransferPayload): boolean {
  if (typeof window === "undefined" || payload.items.length === 0) return false;
  const identity = readBrowserWorkbenchIdentity();
  if (!identity || (payload.ownerUserId && payload.ownerUserId !== identity.userId)) return false;
  clearLegacyVideoTaskTransfer();
  const ownedPayload = { ...payload, ownerUserId: identity.userId };
  try {
    window.sessionStorage.setItem(
      workbenchUserStorageKey(VIDEO_TASK_TRANSFER_KEY, identity.userId),
      JSON.stringify(ownedPayload),
    );
    window.dispatchEvent(new CustomEvent(VIDEO_TASK_TRANSFER_EVENT, { detail: ownedPayload }));
    return true;
  } catch {
    return false;
  }
}

export function readPendingVideoTaskTransfer(): VideoTaskTransferPayload | null {
  if (typeof window === "undefined") return null;
  const identity = readBrowserWorkbenchIdentity();
  if (!identity) return null;
  clearLegacyVideoTaskTransfer();
  const storageKey = workbenchUserStorageKey(VIDEO_TASK_TRANSFER_KEY, identity.userId);
  const raw = window.sessionStorage.getItem(storageKey);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as VideoTaskTransferPayload;
    if (!parsed || parsed.version !== 1 || parsed.ownerUserId !== identity.userId || !Array.isArray(parsed.items)) {
      window.sessionStorage.removeItem(storageKey);
      return null;
    }
    const ageMs = Date.now() - parsed.createdAt;
    if (!Number.isFinite(parsed.createdAt) || ageMs < -60_000 || ageMs > VIDEO_TASK_DRAFT_TTL_MS) {
      window.sessionStorage.removeItem(storageKey);
      return null;
    }
    return parsed;
  } catch {
    window.sessionStorage.removeItem(storageKey);
    return null;
  }
}

export function clearPendingVideoTaskTransfer() {
  if (typeof window !== "undefined") {
    const identity = readBrowserWorkbenchIdentity();
    if (identity) window.sessionStorage.removeItem(workbenchUserStorageKey(VIDEO_TASK_TRANSFER_KEY, identity.userId));
    clearLegacyVideoTaskTransfer();
  }
}

export function extractVideoPromptItemsFromMarkdown(markdown: string): VideoTaskTransferItem[] {
  const text = markdown || "";
  const items: VideoTaskTransferItem[] = [];
  const codeBlockRegex = /```([\w-]*)\n?([\s\S]*?)```/g;
  let match: RegExpExecArray | null;
  let index = 0;

  while ((match = codeBlockRegex.exec(text)) !== null) {
    const language = match[1] || "txt";
    const rawCode = match[2] || "";
    const code = sanitizeVideoPrompt(rawCode);
    const before = text.slice(0, match.index);
    const nearestHeading = before
      .split(/\r?\n/)
      .reverse()
      .map((line) => sanitizeVideoPrompt(line))
      .find((line) => line.length > 0) || "";
    if (!isLikelyVideoPrompt(`${nearestHeading}\n${code}`, language)) continue;
    index += 1;
    const order = inferVideoTaskOrder(`${nearestHeading}\n${code}`, index);
    items.push({
      order,
      prompt: code,
      label: `任务${order}`,
      title: `段落${order}`,
      source: "chat-code",
    });
  }

  if (items.length > 0) return items;

  const parts = text
    .split(/(?:^|\n)(?=(?:段落|图片|任务|卡片|镜头|分镜|第)\s*[\[【（(]?\s*(?:\d{1,2}|[一二三四五六七八九十]))/g)
    .map((part) => sanitizeVideoPrompt(part))
    .filter((part) => part.length > 40);

  return parts.map((part, partIndex) => {
    const order = inferVideoTaskOrder(part, partIndex + 1);
    return {
      order,
      prompt: part,
      label: `任务${order}`,
      title: `段落${order}`,
      source: "chat-message",
    };
  });
}

export function makeOrderedImageFilename(item: {
  order?: number;
  filename?: string;
  label?: string;
  title?: string;
}, fallbackIndex: number, extension = "png"): string {
  if (item.filename) return item.filename;
  const order = normalizeVideoTaskOrder(item.order, fallbackIndex + 1);
  const title = (item.title || item.label || `图片${order}`)
    .replace(/[\\/:*?"<>|]/g, "")
    .replace(/\s+/g, "-")
    .slice(0, 24);
  return `${String(order).padStart(2, "0")}-${title || "image"}.${extension}`;
}
