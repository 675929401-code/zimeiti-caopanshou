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

const SILENT_PROMPT_TERM = "(?:旁白|配音|字幕|音乐|配乐|对白|说话|口播|voice[- ]?over|narration|subtitle|music|dialogue)";
// These finite audio nouns may bridge a negative list, but are not banned sounds.
const SILENT_AUDIO_LIST_MEMBER = `(?:${SILENT_PROMPT_TERM}|快门音|快门声|手机通知声|通知声|警报|心跳警报|倒计时|钟表倒数|燃烧声|火焰声|如厕音效|食物包装声|夸张心跳声|心跳声|惊吓音|痛叫|犬吠|哭喊|呼唤语言|可辨语言)`;
const SILENT_LIST_JOIN = "(?:、|，|,[ \t]*(?:(?:and|or)\\b[ \t]*)?|和|以及|及|与|或|\\band\\b|\\bor\\b)";
const SILENT_TERM_MODIFIER = "(?:(?:任何|背景|口型|开口|角色|同步|人声)[ \t]*)*";
const SILENT_NEGATIVE_CONTEXT = "(?<!不|未|非|不要|不得|不能|没有|不是|并非)";
// Bare 不 is deliberately limited to the immediately following term. It
// does not grant negative scope to an entire list, and double negatives fail.
const SILENT_DIRECT_NOT_PREFIX = new RegExp(`${SILENT_NEGATIVE_CONTEXT}不[ \t]*${SILENT_TERM_MODIFIER}$`, "iu");
// Negation may extend across a list of forbidden terms, never across arbitrary
// prose. In particular, 禁止旁白，但角色说话 must still reject the latter.
const SILENT_NEGATION_PREFIX = new RegExp(
  `${SILENT_NEGATIVE_CONTEXT}(?:无|不含|没有|不得|禁止(?:生成|添加)?|不允许|不要|不生成|不添加|\\bwithout\\b|\\bno\\b)[ \t]*`
    + `((?:${SILENT_TERM_MODIFIER}${SILENT_AUDIO_LIST_MEMBER}[ \t]*${SILENT_LIST_JOIN}[ \t]*)*)${SILENT_TERM_MODIFIER}$`,
  "iu",
);

// A nearby outer negating operator defeats the inner negative exemption.
function followsNegatingOperator(prefix: string) {
  return /(?:不|未|非|不要|不得|不能|没有|不是|并非|禁止)(?:[ \t]*(?:再|去|继续|要|应该|可以|生成|添加|出现|使用|允许|禁止))*[ \t]*$/iu.test(prefix);
}

function isNegatedSilentTerm(value: string, index: number, term: string) {
  const prefix = value.slice(0, index);
  const direct = SILENT_DIRECT_NOT_PREFIX.exec(prefix);
  if (direct) return !followsNegatingOperator(prefix.slice(0, direct.index));
  const negation = SILENT_NEGATION_PREFIX.exec(prefix);
  if (!negation || followsNegatingOperator(prefix.slice(0, negation.index))) return false;
  if (!negation[1]) return true;
  // A comma followed by a positive direction is a new instruction, not a
  // continuation of a negative list: 无音乐，旁白解释故事 remains forbidden.
  const suffix = value.slice(index + term.length);
  return new RegExp(`^[ \t]*(?:${SILENT_LIST_JOIN}[ \t]*${SILENT_TERM_MODIFIER}${SILENT_AUDIO_LIST_MEMBER}[ \t]*)*(?:$|[、，,。；;\\n.!?！？])`, "iu").test(suffix);
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
  const forbidden = new RegExp(SILENT_PROMPT_TERM, "giu");
  for (const match of value.matchAll(forbidden)) {
    if (!isNegatedSilentTerm(value, match.index ?? 0, match[0])) {
      return "视频 Prompt 只能使用无对白的现场动作声；请移除旁白、字幕、音乐或说话指令";
    }
  }
  return null;
}

export function buildStoryboardVideoPrompt({ prompt }: StoryboardVideoPromptOptions) {
  return prompt.trim();
}
