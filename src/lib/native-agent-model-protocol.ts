/** Bounded Anthropic Messages protocol for the first, text/tool-only Agent slice. */
export const NATIVE_AGENT_PROTOCOL_LIMITS = Object.freeze({
  requestBytes: 512 * 1024, responseBytes: 2 * 1024 * 1024,
  depth: 24, nodes: 40_000, messages: 128, blocks: 128, tools: 64,
  maxOutputTokens: 262_144, sseFrames: 16_384,
});

export type NativeAgentJson = null | boolean | number | string | NativeAgentJson[] | { [key: string]: NativeAgentJson };
export type NativeAgentTextBlock = { type: "text"; text: string };
export type NativeAgentToolUseBlock = { type: "tool_use"; id: string; name: string; input: Record<string, NativeAgentJson> };
export type NativeAgentToolResultBlock = {
  type: "tool_result"; tool_use_id: string; content: string | NativeAgentTextBlock[]; is_error?: boolean;
};
export type NativeAgentRequestBlock = NativeAgentTextBlock | NativeAgentToolUseBlock | NativeAgentToolResultBlock;
export interface NativeAgentAnthropicRequest {
  model: string;
  max_tokens: number;
  messages: Array<{ role: "user" | "assistant"; content: string | NativeAgentRequestBlock[] }>;
  system?: string | NativeAgentTextBlock[];
  tools?: Array<{ name: string; description?: string; input_schema: Record<string, NativeAgentJson> }>;
  tool_choice?: { type: "auto" | "any" | "none"; disable_parallel_tool_use?: boolean } | { type: "tool"; name: string; disable_parallel_tool_use?: boolean };
  stream?: boolean;
  temperature?: number;
  top_p?: number;
  top_k?: number;
  stop_sequences?: string[];
}
export interface NativeAgentAnthropicUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}
export interface NativeAgentAnthropicMessage {
  id: string; type: "message"; role: "assistant"; model: string;
  content: Array<NativeAgentTextBlock | NativeAgentToolUseBlock>;
  stop_reason: "end_turn" | "max_tokens" | "stop_sequence" | "tool_use";
  stop_sequence: string | null;
  usage: NativeAgentAnthropicUsage;
}
export class NativeAgentModelProtocolError extends Error {
  constructor(readonly code: string, message: string, readonly status = 400) {
    super(message); this.name = "NativeAgentModelProtocolError";
  }
}
function invalid(message: string): never {
  throw new NativeAgentModelProtocolError("NATIVE_AGENT_PROTOCOL_UNSUPPORTED", message);
}
export function nativeAgentObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid("需要 JSON 对象");
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) invalid("仅支持普通 JSON 对象");
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, allowed: readonly string[]) {
  if (Object.keys(value).some(key => !allowed.includes(key))) invalid("包含首批协议未支持的字段");
}
function string(value: unknown, max = 131_072): asserts value is string {
  if (typeof value !== "string" || value.length > max) invalid("文本字段格式或长度无效");
}
function identifier(value: unknown): asserts value is string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,128}$/u.test(value)) invalid("工具或消息标识无效");
}
function integer(value: unknown, max = Number.MAX_SAFE_INTEGER): asserts value is number {
  if (!Number.isSafeInteger(value) || Number(value) < 0 || Number(value) > max) invalid("Token 或整数参数无效");
}

/** Reject accessors, cycles, non-JSON values and oversized graphs before serialization. */
export function nativeAgentBoundedJson(value: unknown, maxBytes = NATIVE_AGENT_PROTOCOL_LIMITS.requestBytes): NativeAgentJson {
  let nodes = 0;
  let stringBytes = 0;
  const ancestors = new Set<object>();
  const walk = (item: unknown, depth: number): NativeAgentJson => {
    if (++nodes > NATIVE_AGENT_PROTOCOL_LIMITS.nodes || depth > NATIVE_AGENT_PROTOCOL_LIMITS.depth) invalid("JSON 结构超过限制");
    if (item === null || typeof item === "boolean") return item;
    if (typeof item === "number") { if (!Number.isFinite(item)) invalid("JSON 数值无效"); return item; }
    if (typeof item === "string") {
      stringBytes += Buffer.byteLength(item, "utf8");
      if (stringBytes > maxBytes) invalid("请求或结果超过字节限制");
      return item;
    }
    if (typeof item !== "object" || !item) invalid("只支持 JSON 数据");
    if (ancestors.has(item)) invalid("JSON 不允许循环引用");
    ancestors.add(item);
    let result: NativeAgentJson;
    if (Array.isArray(item)) {
      if (item.length > NATIVE_AGENT_PROTOCOL_LIMITS.nodes) invalid("JSON 数组超过限制");
      const descriptors = Object.getOwnPropertyDescriptors(item);
      if (Object.getOwnPropertySymbols(item).length || Object.keys(descriptors).length !== item.length + 1) invalid("JSON 数组含有自定义字段或空槽");
      result = Array.from({ length: item.length }, (_, index) => {
        const descriptor = descriptors[String(index)];
        if (!descriptor?.enumerable || !("value" in descriptor)) invalid("JSON 数组不接收访问器或空槽");
        return walk(descriptor.value, depth + 1);
      });
    } else {
      nativeAgentObject(item);
      const descriptors = Object.getOwnPropertyDescriptors(item);
      const entries = Object.entries(descriptors);
      if (entries.length > NATIVE_AGENT_PROTOCOL_LIMITS.nodes || Object.getOwnPropertySymbols(item).length) invalid("JSON 字段无效");
      result = Object.fromEntries(entries.map(([key, descriptor]) => {
        if (!descriptor.enumerable || !("value" in descriptor) || ["__proto__", "constructor", "prototype"].includes(key)) invalid("JSON 字段不安全");
        stringBytes += Buffer.byteLength(key, "utf8");
        if (stringBytes > maxBytes) invalid("JSON 字段超过限制");
        return [key, walk(descriptor.value, depth + 1)];
      }));
    }
    ancestors.delete(item);
    return result;
  };
  const result = walk(value, 0);
  if (Buffer.byteLength(JSON.stringify(result), "utf8") > maxBytes) invalid("请求或结果超过字节限制");
  return result;
}
export function nativeAgentCanonicalJson(value: unknown): string {
  const sort = (item: unknown): unknown => Array.isArray(item) ? item.map(sort)
    : item && typeof item === "object" ? Object.fromEntries(Object.keys(item).sort().map(key => [key, sort((item as Record<string, unknown>)[key])])) : item;
  return JSON.stringify(sort(value));
}
function textBlock(value: unknown): NativeAgentTextBlock {
  const block = nativeAgentObject(value); keys(block, ["type", "text"]);
  if (block.type !== "text") invalid("首批仅支持文本，不支持图片、文档、URL 来源或缓存控制");
  string(block.text); return block as NativeAgentTextBlock;
}
function toolUse(value: Record<string, unknown>): NativeAgentToolUseBlock {
  keys(value, ["type", "id", "name", "input"]); identifier(value.id); identifier(value.name); nativeAgentObject(value.input);
  return value as NativeAgentToolUseBlock;
}
function blocks(value: unknown): unknown[] {
  if (!Array.isArray(value) || value.length > NATIVE_AGENT_PROTOCOL_LIMITS.blocks) invalid("内容块格式或数量无效");
  return value;
}

/** Unknown keys are rejected, never stripped before hashing, quoting or sending. */
export function parseNativeAgentAnthropicRequest(raw: unknown): NativeAgentAnthropicRequest {
  if (typeof raw === "string") {
    if (Buffer.byteLength(raw, "utf8") > NATIVE_AGENT_PROTOCOL_LIMITS.requestBytes) invalid("请求超过字节限制");
    try { raw = JSON.parse(raw); } catch { invalid("请求 JSON 无效"); }
  }
  const request = nativeAgentObject(nativeAgentBoundedJson(raw));
  keys(request, ["model", "max_tokens", "messages", "system", "tools", "tool_choice", "stream", "temperature", "top_p", "top_k", "stop_sequences"]);
  string(request.model, 200); if (!request.model) invalid("缺少模型标识");
  integer(request.max_tokens, NATIVE_AGENT_PROTOCOL_LIMITS.maxOutputTokens); if (!request.max_tokens) invalid("必须指定输出 Token 上限");
  if (!Array.isArray(request.messages) || !request.messages.length || request.messages.length > NATIVE_AGENT_PROTOCOL_LIMITS.messages) invalid("消息数量无效");
  const usedTools = new Map<string, string>();
  const resolvedTools = new Set<string>();
  const toolNames = new Set<string>();
  if (request.tools !== undefined) {
    if (!Array.isArray(request.tools) || request.tools.length > NATIVE_AGENT_PROTOCOL_LIMITS.tools) invalid("工具数量无效");
    for (const value of request.tools) {
      const tool = nativeAgentObject(value); keys(tool, ["name", "description", "input_schema"]); identifier(tool.name);
      if (toolNames.has(tool.name)) invalid("工具名称重复"); toolNames.add(tool.name);
      if (tool.description !== undefined) string(tool.description, 32_768);
      if (nativeAgentObject(tool.input_schema).type !== "object") invalid("工具 input_schema 必须为对象 Schema");
    }
  }
  for (const value of request.messages) {
    const message = nativeAgentObject(value); keys(message, ["role", "content"]);
    if (message.role !== "user" && message.role !== "assistant") invalid("消息角色无效");
    if (typeof message.content === "string") { string(message.content); continue; }
    for (const item of blocks(message.content)) {
      const block = nativeAgentObject(item);
      if (block.type === "text") textBlock(block);
      else if (block.type === "tool_use" && message.role === "assistant") {
        const tool = toolUse(block);
        if (!toolNames.has(tool.name) || usedTools.has(tool.id)) invalid("工具调用名称未知或标识重复");
        usedTools.set(tool.id, tool.name);
      } else if (block.type === "tool_result" && message.role === "user") {
        keys(block, ["type", "tool_use_id", "content", "is_error"]); identifier(block.tool_use_id);
        if (!usedTools.has(block.tool_use_id) || resolvedTools.has(block.tool_use_id)) invalid("工具反馈缺少对应调用或重复");
        resolvedTools.add(block.tool_use_id);
        if (typeof block.content === "string") string(block.content);
        else blocks(block.content).forEach(textBlock);
        if (block.is_error !== undefined && typeof block.is_error !== "boolean") invalid("工具错误标识无效");
      } else invalid("首批不支持该内容块或角色");
    }
  }
  if (usedTools.size !== resolvedTools.size) invalid("模型续接缺少先前工具调用的完整反馈");
  if (request.system !== undefined) {
    if (typeof request.system === "string") string(request.system);
    else blocks(request.system).forEach(textBlock);
  }
  if (request.stream !== undefined && typeof request.stream !== "boolean") invalid("stream 格式无效");
  for (const key of ["temperature", "top_p"]) {
    const n = request[key]; if (n !== undefined && (typeof n !== "number" || n < 0 || n > 1)) invalid("采样参数无效");
  }
  if (request.top_k !== undefined) integer(request.top_k, 100_000);
  if (request.stop_sequences !== undefined) {
    if (!Array.isArray(request.stop_sequences) || request.stop_sequences.length > 16) invalid("停止序列无效");
    request.stop_sequences.forEach(value => string(value, 1024));
  }
  if (request.tool_choice !== undefined) {
    const choice = nativeAgentObject(request.tool_choice); keys(choice, ["type", "name", "disable_parallel_tool_use"]);
    if (!["auto", "any", "none", "tool"].includes(String(choice.type))) invalid("工具选择策略无效");
    if (choice.type === "tool") { identifier(choice.name); if (!toolNames.has(choice.name)) invalid("指定工具不存在"); }
    else if (choice.name !== undefined) invalid("非指定工具策略不接收名称");
    if (choice.disable_parallel_tool_use !== undefined && typeof choice.disable_parallel_tool_use !== "boolean") invalid("并行工具策略无效");
    if (!toolNames.size && choice.type !== "none") invalid("工具选择策略缺少工具");
  }
  return request as unknown as NativeAgentAnthropicRequest;
}

export function validateNativeAgentAnthropicMessage(raw: unknown, request: NativeAgentAnthropicRequest): NativeAgentAnthropicMessage {
  const message = nativeAgentObject(nativeAgentBoundedJson(raw, NATIVE_AGENT_PROTOCOL_LIMITS.responseBytes));
  keys(message, ["id", "type", "role", "model", "content", "stop_reason", "stop_sequence", "usage"]);
  identifier(message.id);
  if (message.type !== "message" || message.role !== "assistant" || message.model !== request.model) invalid("上游消息身份与冻结模型不符");
  if (!["end_turn", "max_tokens", "stop_sequence", "tool_use"].includes(String(message.stop_reason))) invalid("缺少支持的 Anthropic 终态原因");
  if (message.stop_sequence !== null && typeof message.stop_sequence !== "string") invalid("终态停止序列无效");
  if (message.stop_reason === "stop_sequence" && (!request.stop_sequences?.includes(String(message.stop_sequence)))) invalid("上游停止序列不属于请求");
  if (message.stop_reason !== "stop_sequence" && message.stop_sequence !== null) invalid("终态停止序列不一致");
  const usage = nativeAgentObject(message.usage);
  keys(usage, ["input_tokens", "output_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"]);
  integer(usage.input_tokens); integer(usage.output_tokens);
  if (usage.cache_read_input_tokens !== undefined) integer(usage.cache_read_input_tokens);
  if (usage.cache_creation_input_tokens !== undefined) integer(usage.cache_creation_input_tokens);
  // The shared price contract has a read-cache rate but no cache-write rate.
  if (Number(usage.cache_creation_input_tokens || 0) !== 0) invalid("当前价格合同不支持缓存写入费用");
  const names = new Set(request.tools?.map(tool => tool.name) || []);
  const ids = new Set<string>();
  for (const block of blocks(message.content)) {
    const item = nativeAgentObject(block);
    if (item.type === "text") textBlock(item);
    else if (item.type === "tool_use") {
      const tool = toolUse(item);
      if (!names.has(tool.name) || ids.has(tool.id)) invalid("上游工具调用不属于当前请求或标识重复");
      if (request.tool_choice?.type === "none" || (request.tool_choice?.type === "tool" && request.tool_choice.name !== tool.name)) invalid("上游工具调用违背请求工具策略");
      ids.add(tool.id);
    } else invalid("上游返回未支持的内容类型");
  }
  if ((message.stop_reason === "tool_use") !== (ids.size > 0)) invalid("工具调用与终态原因不一致");
  return message as unknown as NativeAgentAnthropicMessage;
}

export interface NativeAgentBufferedDelivery {
  /** SSE is retained from the provider and released after settlement; it is not live token streaming. */
  mode: "json" | "buffered_original_sse";
  body: string;
  contentType: "application/json" | "text/event-stream";
}

function parseNativeSse(body: string): unknown {
  const frames = body.split(/\r?\n\r?\n/u);
  if (frames.length > NATIVE_AGENT_PROTOCOL_LIMITS.sseFrames) invalid("上游事件数量超过限制");
  let message: Record<string, unknown> | undefined;
  let stopped = false;
  let sawDelta = false;
  let finalOutputReported = false;
  let active: { index: number; block: Record<string, unknown>; json: string } | undefined;
  const content: Record<string, unknown>[] = [];
  for (const frame of frames) {
    const lines = frame.split(/\r?\n/u);
    const data = lines.filter(line => line.startsWith("data:")).map(line => line.slice(5).replace(/^ /u, "")).join("\n");
    if (!data) continue;
    let parsed: unknown; try { parsed = JSON.parse(data); } catch { invalid("原生上游事件 JSON 无效"); }
    const event = nativeAgentObject(nativeAgentBoundedJson(parsed, NATIVE_AGENT_PROTOCOL_LIMITS.responseBytes));
    const declared = lines.find(line => line.startsWith("event:"))?.slice(6).trim();
    if (declared && declared !== event.type) invalid("原生事件类型不一致");
    if (stopped) invalid("message_stop 后出现额外上游事件");
    if (event.type === "ping") continue;
    if (event.type === "message_start") {
      if (message) invalid("重复的 message_start");
      message = nativeAgentObject(event.message);
      if (!Array.isArray(message.content) || message.content.length) invalid("message_start 包含非空内容");
      const usage = nativeAgentObject(message.usage); integer(usage.input_tokens); integer(usage.output_tokens);
      message = { ...message, content, usage: { ...usage } }; continue;
    }
    if (!message) invalid("事件缺少 message_start");
    if (event.type === "content_block_start") {
      integer(event.index, NATIVE_AGENT_PROTOCOL_LIMITS.blocks - 1);
      if (active || sawDelta || event.index !== content.length) invalid("内容块顺序无效");
      const block = nativeAgentObject(event.content_block);
      if (block.type === "text") textBlock(block);
      else if (block.type === "tool_use") { toolUse(block); if (Object.keys(nativeAgentObject(block.input)).length) invalid("流式工具 input 必须从空对象开始"); }
      else invalid("首批未支持的流式内容块");
      active = { index: Number(event.index), block: { ...block }, json: "" }; continue;
    }
    if (event.type === "content_block_delta") {
      if (!active || event.index !== active.index) invalid("增量内容块不匹配");
      const delta = nativeAgentObject(event.delta);
      if (active.block.type === "text" && delta.type === "text_delta") { string(delta.text); active.block.text = String(active.block.text) + delta.text; }
      else if (active.block.type === "tool_use" && delta.type === "input_json_delta") { string(delta.partial_json); active.json += delta.partial_json; }
      else invalid("流式增量类型无效");
      continue;
    }
    if (event.type === "content_block_stop") {
      if (!active || event.index !== active.index) invalid("内容块终态不匹配");
      if (active.block.type === "tool_use" && active.json) {
        try { active.block.input = JSON.parse(active.json); } catch { invalid("工具输入增量未组成完整 JSON"); }
      }
      content.push(active.block); active = undefined; continue;
    }
    if (event.type === "message_delta") {
      if (active) invalid("消息终态早于内容块终态"); sawDelta = true;
      const delta = nativeAgentObject(event.delta); keys(delta, ["stop_reason", "stop_sequence"]);
      if (delta.stop_reason !== undefined && delta.stop_reason !== null) {
        if (message.stop_reason !== null && message.stop_reason !== undefined && message.stop_reason !== delta.stop_reason) invalid("终态原因发生冲突");
        message.stop_reason = delta.stop_reason;
      }
      if (delta.stop_sequence !== undefined) message.stop_sequence = delta.stop_sequence;
      if (event.usage !== undefined) {
        const usage = nativeAgentObject(event.usage); keys(usage, ["output_tokens"]); integer(usage.output_tokens);
        const previous = nativeAgentObject(message.usage);
        if (Number(usage.output_tokens) < Number(previous.output_tokens)) invalid("累计输出用量回退");
        message.usage = { ...previous, output_tokens: usage.output_tokens }; finalOutputReported = true;
      }
      continue;
    }
    if (event.type === "message_stop") {
      if (active || !sawDelta || !finalOutputReported) invalid("原生终态缺少完整内容或最终用量"); stopped = true; continue;
    }
    invalid("上游发生错误或返回未支持事件");
  }
  if (!stopped || !message) invalid("上游关闭但未确认 message_stop");
  return message;
}

export async function readNativeAgentAnthropicResponse(response: Response, request: NativeAgentAnthropicRequest, signal?: AbortSignal) {
  if (!response.ok || !response.body) throw new NativeAgentModelProtocolError("NATIVE_AGENT_UPSTREAM_RESULT_UNKNOWN", "上游未返回可结算的完整原协议响应", 503);
  const type = (response.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
  if (!["application/json", "text/event-stream"].includes(type)) invalid("上游响应不是支持的 Anthropic 协议");
  const reader = response.body.getReader(); const decoder = new TextDecoder("utf-8", { fatal: true });
  const parts: string[] = []; let bytes = 0;
  const cancel = () => { void reader.cancel().catch(() => undefined); };
  signal?.addEventListener("abort", cancel, { once: true });
  try {
    while (true) {
      if (signal?.aborted) throw new NativeAgentModelProtocolError("NATIVE_AGENT_CALL_CANCELLED_UNKNOWN", "调用已取消，需核对原调用终态", 409);
      const item = await reader.read(); if (item.done) break;
      bytes += item.value.byteLength;
      if (bytes > NATIVE_AGENT_PROTOCOL_LIMITS.responseBytes) invalid("上游结果超过有界缓存限制");
      parts.push(decoder.decode(item.value, { stream: true }));
    }
    if (signal?.aborted) throw new NativeAgentModelProtocolError("NATIVE_AGENT_CALL_CANCELLED_UNKNOWN", "调用已取消，需核对原调用终态", 409);
    parts.push(decoder.decode());
  } finally { signal?.removeEventListener("abort", cancel); await reader.cancel().catch(() => undefined); reader.releaseLock(); }
  const body = parts.join("");
  let raw: unknown;
  if (type === "text/event-stream") raw = parseNativeSse(body);
  else { try { raw = JSON.parse(body); } catch { invalid("上游 JSON 未完整返回"); } }
  const message = validateNativeAgentAnthropicMessage(raw, request);
  const delivery: NativeAgentBufferedDelivery = { mode: type === "text/event-stream" ? "buffered_original_sse" : "json", body, contentType: type as NativeAgentBufferedDelivery["contentType"] };
  return { message, delivery };
}
