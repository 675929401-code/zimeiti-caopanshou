/**
 * LLM Proxy — 独立模块
 * 
 * 设计理念（抄作业 AIWeb）：
 * 1. 隔离：LLM 代理逻辑与系统其他代码完全解耦，任何系统变更不影响此处
 * 2. 默认模板：DEFAULT_CONFIG 是经过验证的固定模板，出问题时恢复默认即可
 * 3. 格式统一：不管后端调哪个模型，输出统一转成 OpenAI SSE 格式
 * 4. 快速响应：先发流再异步扣费（对齐 AIWeb），不阻塞首字节
 * 5. 连接复用：keep-alive + HTTP/2 复用，减少 TLS 握手开销
 */

export { LLMProxy, DEFAULT_PROXY_CONFIG, getLLMProxy, resetLLMProxy } from "./proxy";
export type { ProxyConfig, ProxyResult, StreamCallbacks, SSEChunk, ChatRequest } from "./types";
