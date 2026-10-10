/**
 * 🔒 核心底层代码 — 锁定保护
 *
 * 本文件是思考标签解析与指令注入模块。
 * 修改此文件需要用户明确同意，详见 AGENTS.md "🔒 锁定模块清单 #9 格式输出层"。
 *
 * 锁定范围：整个文件
 * 锁定原因：思考标签格式是前后端协议，修改会导致前端无法解析思考内容
 */

/**
 * 思考标记指令模块
 *
 * 为所有智能体统一注入思考格式指令：
 * - AI 在思考时使用 <think🌍>...</think🌍> 标签包裹思考过程
 * - 正文内容在标签外输出
 * - 前端解析标签后，思考块折叠显示，正文正常渲染
 *
 * 设计原则：
 * - 指令简洁，不占用过多 token
 * - 不干扰 AI 原有能力和风格
 * - 兼容已有 reasoning_content（DeepSeek 等原生支持）
 */

/** 思考标记指令 — 注入到 system prompt 末尾 */
export const THINK_INSTRUCTION = `

【输出格式要求】
在回答用户问题之前，先用 <think🌍> 标签包裹你的思考分析过程，然后再给出正式回答。
格式：
<think🌍>
这里写你的思考过程、分析逻辑、推理步骤
</think🌍>

这里写你的正式回答内容

注意：思考过程和正式回答都必须输出，缺一不可。`;

/** 将思考指令追加到系统提示词末尾 */
export function appendThinkInstruction(systemPrompt: string): string {
  if (!systemPrompt) return THINK_INSTRUCTION.trim();
  // 避免重复注入
  if (systemPrompt.includes('<think🌍>')) return systemPrompt;
  return systemPrompt + THINK_INSTRUCTION;
}

/** 将思考指令追加到用户消息前缀（Coze 智能体，无法修改 system prompt 时使用） */
export function prependThinkInstruction(message: string): string {
  // 避免重复注入
  if (message.includes('<think🌍>')) return message;
  return `【指令】请在回答前先用 <think🌍> 标签包裹思考过程，然后在标签外给出正式回答。\n\n${message}`;
}

/**
 * 从流式内容中解析思考标签
 *
 * 支持多种思考标签格式：
 * - <think🌍>...</think🌍> — 本平台自定义标签（注入指令后使用）
 * - <think compatible>...</think compatible> — DeepSeek/智谱等推理模型原生输出
 * - <thinking>...</thinking> — 部分模型使用
 *
 * 流式场景下，内容是逐块到达的，标签可能跨越多个 chunk：
 * - 遇到开标签后，后续内容归入 reasoningContent
 * - 遇到闭标签后，后续内容归入 fullContent
 * - 支持多轮思考（多个 think 块）
 *
 * @param content 当前累积的完整内容
 * @returns { reasoningContent, displayContent } 分离后的思考内容和正文
 */
export function parseThinkTags(content: string): {
  reasoningContent: string;
  displayContent: string;
} {
  const reasoningParts: string[] = [];
  const displayParts: string[] = [];

  // 支持的思考标签格式（按优先级排序）
  const thinkPatterns = [
    { open: '<think🌍>', close: '</think🌍>' },
    { open: '<think compatible>', close: '</think compatible>' },
  ];

  // 通用匹配：<think...> 和 </think...>（兼容各种变体如 <think compatible/> 等）
  const openRe = /<think[^>]*>/gi;
  const closeRe = /<\/think[^>]*>/gi;
  // <thinking> 标签
  const thinkingOpenRe = /<thinking[^>]*>/gi;
  const thinkingCloseRe = /<\/thinking[^>]*>/gi;

  let remaining = content;
  let inThink = false;

  // A streaming chunk may stop halfway through an opening tag ("<t",
  // "<think compatible", ...). Publishing that suffix as answer text and
  // retracting it when the next chunk completes the tag makes the visible
  // response go backwards. Keep only the ambiguous trailing fragment buffered;
  // invalid lookalikes become visible as soon as the next character proves
  // that they are ordinary text.
  const withoutIncompleteOpenTag = (value: string) => {
    const lastOpen = value.lastIndexOf('<');
    if (lastOpen < 0) return value;
    const tail = value.slice(lastOpen);
    const lowerTail = tail.toLowerCase();
    const isTagPrefix = ['<think🌍>', '<think compatible>', '<thinking>']
      .some((tag) => tag.startsWith(lowerTail));
    const isUnclosedThinkTag = /^<think(?:ing)?(?:\s[^>]*)?$/iu.test(tail);
    return isTagPrefix || isUnclosedThinkTag ? value.slice(0, lastOpen) : value;
  };

  while (remaining.length > 0) {
    if (inThink) {
      // 查找闭合标签：优先精确匹配，再通用匹配
      let closeIdx = -1;
      let closeTagLen = 0;

      // 尝试精确匹配已知格式
      for (const pattern of thinkPatterns) {
        const idx = remaining.indexOf(pattern.close);
        if (idx !== -1 && (closeIdx === -1 || idx < closeIdx)) {
          closeIdx = idx;
          closeTagLen = pattern.close.length;
        }
      }
      // 通用 </think...> 匹配
      closeRe.lastIndex = 0;
      const genericClose = closeRe.exec(remaining);
      if (genericClose && (closeIdx === -1 || genericClose.index < closeIdx)) {
        closeIdx = genericClose.index;
        closeTagLen = genericClose[0].length;
      }
      // </thinking> 匹配
      thinkingCloseRe.lastIndex = 0;
      const thinkingClose = thinkingCloseRe.exec(remaining);
      if (thinkingClose && (closeIdx === -1 || thinkingClose.index < closeIdx)) {
        closeIdx = thinkingClose.index;
        closeTagLen = thinkingClose[0].length;
      }

      if (closeIdx === -1) {
        // 还没收到闭合标签，全部是思考内容
        reasoningParts.push(remaining);
        break;
      }
      // 提取思考内容（闭合标签之前的部分）
      reasoningParts.push(remaining.slice(0, closeIdx));
      remaining = remaining.slice(closeIdx + closeTagLen);
      inThink = false;
    } else {
      // 查找开标签
      let openIdx = -1;
      let openTagLen = 0;

      // 精确匹配
      for (const pattern of thinkPatterns) {
        const idx = remaining.indexOf(pattern.open);
        if (idx !== -1 && (openIdx === -1 || idx < openIdx)) {
          openIdx = idx;
          openTagLen = pattern.open.length;
        }
      }
      // 通用 <think...> 匹配
      openRe.lastIndex = 0;
      const genericOpen = openRe.exec(remaining);
      if (genericOpen && (openIdx === -1 || genericOpen.index < openIdx)) {
        openIdx = genericOpen.index;
        openTagLen = genericOpen[0].length;
      }
      // <thinking> 匹配
      thinkingOpenRe.lastIndex = 0;
      const thinkingOpen = thinkingOpenRe.exec(remaining);
      if (thinkingOpen && (openIdx === -1 || thinkingOpen.index < openIdx)) {
        openIdx = thinkingOpen.index;
        openTagLen = thinkingOpen[0].length;
      }

      if (openIdx === -1) {
        // 没有完整开标签：正文可以公开，但跨 chunk 的标签前缀必须先缓冲，
        // 避免先显示“<thi”再在标签闭合时整段回退。
        displayParts.push(withoutIncompleteOpenTag(remaining));
        break;
      }
      // 提取正文（开标签之前的部分）
      if (openIdx > 0) {
        displayParts.push(remaining.slice(0, openIdx));
      }
      remaining = remaining.slice(openIdx + openTagLen);
      inThink = true;
    }
  }

  return {
    reasoningContent: reasoningParts.join('').trim(),
    displayContent: displayParts.join('').trim(),
  };
}
