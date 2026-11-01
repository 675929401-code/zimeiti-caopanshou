import MarkdownIt from 'markdown-it';
import { getCodeBlockPresentation, isPlaintextCodeLanguage } from './code-block-presentation';
import { isLikelyVideoPrompt, type VideoTaskTransferPayload } from './video-task-transfer';
import { parseStructuredAgentOutput } from './structured-agent-output';
import { isChatPromptDeliveryMessageReady } from './chat-prompt-delivery-state';

const parser = new MarkdownIt({ html: false });

/** Build a draft from this reply only. Never collect previous assistant replies
 * or rewrite literal prompt words through the legacy UI-text sanitizer. */
export function buildChatVideoPromptTransfer(text: string, codeBlockIndex?: number, expectedCodeText?: string): VideoTaskTransferPayload | null {
  if (!isChatPromptDeliveryMessageReady({ role: 'assistant', content: text }) || text.length > 500_000) return null;
  const lines = text.split('\n');
  const sourceLines = text.match(/[^\r\n]*(?:\r\n|\n|\r|$)/gu) || [];
  const fences = parser.parse(text, {}).filter(token => token.type === 'fence' || token.type === 'code_block');
  const candidates: Array<{ index: number; item: VideoTaskTransferPayload['items'][number] }> = [];
  // Validate closure even when another fence later turns out not to be video.
  for (const token of fences) {
    if (token.type !== 'fence' || !token.map) return null;
    const closing = sourceLines[token.map[1] - 1]?.replace(/[\r\n]+$/u, '');
    const marker = token.markup[0];
    if (!closing || !new RegExp(`^[ \\t>]*${marker}{${token.markup.length},}[ \\t]*$`, 'u').test(closing)) return null;
  }
  if (codeBlockIndex === undefined) {
    const structured = parseStructuredAgentOutput(text, true, { allowQualityWarnings: true });
    if (structured.status === 'valid' && structured.source === 'stable_json' && structured.segments.length) {
      if (structured.segments.length > 40) throw new Error('视频创作一次最多接收 40 条提示词，请分批推送。');
      return { version: 1, createdAt: Date.now(), mode: 'batch', items: structured.segments.map((segment, index) => ({
        order: index + 1, prompt: segment.video_prompt, label: segment.segment_id, title: segment.narration, source: 'chat-message',
      })) };
    }
  }
  let videoOrder = 0;
  for (const [index, token] of fences.entries()) {
    const language = token.info.trim().split(/\s/u)[0] || '';
    if (!isPlaintextCodeLanguage(language)) continue;
    const context = lines.slice(0, token.map?.[0] || 0).filter(line => line.trim()).at(-1) || '';
    if (!token.map) return null;
    const logicalLines = token.content.replace(/\n$/u, '').split('\n');
    const rawBody = sourceLines.slice(token.map[0] + 1, token.map[1] - 1);
    if (rawBody.length !== logicalLines.length) return null;
    let content = '';
    for (const [lineIndex, raw] of rawBody.entries()) {
      const ending = raw.match(/(?:\r\n|\r|\n)$/u)?.[0] || '';
      const body = ending ? raw.slice(0, -ending.length) : raw;
      const logical = logicalLines[lineIndex];
      if (!body.endsWith(logical) || !/^[ \t>]*$/u.test(body.slice(0, body.length - logical.length))) return null;
      content += logical + (lineIndex === rawBody.length - 1 ? '' : ending);
    }
    const purpose = getCodeBlockPresentation(content, language, context).purpose;
    if (purpose === 'image-prompt' || !content.trim()) continue;
    if (purpose !== 'video-prompt' && !isLikelyVideoPrompt(`${context}\n${content}`, language)) continue;
    videoOrder++;
    candidates.push({ index, item: { order: videoOrder, prompt: content, label: `任务${videoOrder}`, title: context.replace(/^\s*#+\s*/u, '').trim() || `视频提示词 ${videoOrder}`, source: 'chat-code' } });
  }
  if (codeBlockIndex !== undefined && (!Number.isInteger(codeBlockIndex) || codeBlockIndex < 0 || codeBlockIndex >= fences.length)) return null;
  let selected = candidates;
  if (codeBlockIndex !== undefined) {
    if (expectedCodeText !== undefined) {
      const literal = (value: string) => value.replace(/\r\n?/gu, '\n').replace(/\n$/u, '');
      // Rendering can hide a machine transport fence. Match the clicked literal
      // against original source, rather than trusting a shifted DOM ordinal.
      selected = candidates.filter(candidate => literal(candidate.item.prompt || '') === literal(expectedCodeText));
      if (selected.length !== 1) return null;
    } else selected = candidates.filter(candidate => candidate.index === codeBlockIndex);
  }
  const items = selected.map(candidate => candidate.item);
  if (items.some(item => item.order > 40)) throw new Error('这条提示词超过视频创作的 40 张卡片容量，请分批推送。');
  if (items.length > 40) throw new Error('视频创作一次最多接收 40 条提示词，请分批推送。');
  if (!items.length && !fences.length && codeBlockIndex === undefined
    && !/(?:生图|图片|图像|image)\s*(?:Prompt|提示词)/iu.test(text)
    && text.replace(/!\[[^\]]*\]\([^)]*\)/gu, '').trim()
    && isLikelyVideoPrompt(text)) {
    items.push({ order: 1, prompt: text.trim(), label: '任务1', title: '来自当前智能体回复', source: 'chat-message' });
  }
  return items.length ? { version: 1, createdAt: Date.now(), mode: items.length > 1 ? 'batch' : 'single', items } : null;
}
