import { containsPromptLeak, normalizeBipGuardText } from '../business-ip/guard';

export class BipStreamPromptLeakError extends Error {
  readonly code = 'PROMPT_OUTPUT_BLOCKED';
  constructor() { super('回复未通过内部信息保护检查，本次输出未完成。'); }
}

/**
 * Release only complete lines followed by >=90 normalized withheld characters.
 * A newline is an NFKC boundary: later combining marks cannot rewrite the
 * emitted prefix. Character counts use the exact shared leakage normalization.
 * Reasoning and provider metadata never pass through this gate.
 */
export function createBipGuardedStream(systemPrompt: string) {
  let emitted = '';
  let latest = '';
  let blocked = false;
  const review = (content: string) => {
    if (blocked || !content.startsWith(latest) || containsPromptLeak(content, systemPrompt)) {
      blocked = true;
      throw new BipStreamPromptLeakError();
    }
    latest = content;
  };
  return {
    update(content: string): string {
      review(content);
      let safeEnd = emitted.length;
      let boundary = content.indexOf('\n', emitted.length);
      while (boundary >= 0) {
        const nextEnd = boundary + 1;
        const normalizedSuffix = normalizeBipGuardText(content.slice(nextEnd));
        // Lowercasing happens after whitespace removal. A Greek final sigma
        // before this newline may still change if the entire tail is
        // Case_Ignorable. Require a known casing boundary in the withheld tail.
        if (normalizedSuffix.length < 90 || !/\P{Case_Ignorable}/u.test(normalizedSuffix)) break;
        safeEnd = nextEnd;
        boundary = content.indexOf('\n', nextEnd);
      }
      const delta = content.slice(emitted.length, safeEnd);
      emitted = content.slice(0, safeEnd);
      return delta;
    },
    finish(content: string, settled: boolean): string {
      review(content);
      if (!settled) throw new Error('BIP_STREAM_SETTLEMENT_REQUIRED');
      const delta = content.slice(emitted.length);
      emitted = content;
      return delta;
    },
  };
}
