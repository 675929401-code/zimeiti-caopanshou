import { countEffectiveNarrationCharacters } from "./storyboard-duration-contract";

type StoryboardVideoPromptOptions = {
  prompt: string;
  duration: number;
  // Stored runs may still carry narration, but narration is metadata and is
  // never mixed into the user's provider prompt.
  narration?: string;
};

export function inferStoryboardNarration(label?: string) {
  const value = String(label || "").trim();
  if (!value) return "";
  const separator = value.indexOf("｜");
  return separator >= 0 ? value.slice(separator + 1).trim() : "";
}

export function narrationCharacterCount(narration?: string) {
  return countEffectiveNarrationCharacters(String(narration || ""));
}

// Compatibility export only. The workbench sends the user's prompt verbatim;
// technical settings travel in their dedicated request fields.
export function storyboardVideoRuntimeGuard(_duration: number) {
  return "";
}

/** Returns a user-facing reason when a manually pasted prompt violates the
 * single-image storyboard contract. The compile route has its own normalizer;
 * this second gate protects older drafts and clipboard imports at submit time.
 */
export function storyboardVideoPromptViolation(prompt: string): string | null {
  const value = String(prompt || "").trim();
  if (!value) return "请先粘贴图生视频 Prompt";
  if (/(?:裁切|裁剪|拆格|分格|第一格|首格)[^。；\n]{0,28}(?:生成|作为|上传|参考)/u.test(value)
    && !/(?:不裁切|不裁剪|不拆格|不分格)/u.test(value)) {
    return "视频 Prompt 不能要求裁切或拆分故事板；请提交完整四宫格或五宫格单图";
  }
  const forbidden = /(旁白|配音|字幕|音乐|对白|说话|voice[- ]?over|narration|subtitle|music|dialogue)/giu;
  for (const match of value.matchAll(forbidden)) {
    const prefix = value.slice(Math.max(0, (match.index ?? 0) - 6), match.index ?? 0);
    if (!/(?:无|不含|没有|不得|禁止|without|no)\s*$/iu.test(prefix)) {
      return "视频 Prompt 只能使用无对白的现场动作声；请移除旁白、字幕、音乐或说话指令";
    }
  }
  return null;
}

export function buildStoryboardVideoPrompt({ prompt }: StoryboardVideoPromptOptions) {
  return prompt.trim();
}
