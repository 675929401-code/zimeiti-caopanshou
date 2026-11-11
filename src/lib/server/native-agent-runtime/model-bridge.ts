import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { NativeAgentToolSchema } from "../../native-agent-contract";
import type { NativeAgentRuntimeEvent, NativeAgentRuntimeModelCall, NativeAgentSdkTurnInput } from "./types";

const allowedTools = new Set(["mcp__native_drafts__read_draft", "mcp__native_drafts__save_draft"]);
const allowedBodyFields = new Set(["model", "max_tokens", "messages", "system", "tools", "tool_choice", "thinking", "temperature", "top_p", "top_k", "stop_sequences", "stream", "output_config", "context_management", "service_tier"]);
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

async function readBody(request: IncomingMessage, limit: number): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += value.length;
    if (size > limit) throw new Error("NATIVE_AGENT_BRIDGE_BODY_LIMIT");
    chunks.push(value);
  }
  const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (!record(parsed)) throw new Error("NATIVE_AGENT_BRIDGE_BODY_INVALID");
  return parsed;
}
function error(response: ServerResponse, status: number, code: string) {
  if (!response.headersSent) response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  response.end(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: code } }));
}

export async function createNativeAgentModelBridge(options: {
  input: NativeAgentSdkTurnInput;
  signal: AbortSignal;
  emit(kind: NativeAgentRuntimeEvent["kind"], payload: Record<string, unknown>): Promise<void>;
  modelCall(input: NativeAgentRuntimeModelCall): Promise<Response>;
  onFailure?(): void;
}) {
  const token = randomBytes(32).toString("hex");
  const expectedToken = Buffer.from(token);
  let calls = 0;
  let rejectedRequests = 0;
  let fatal = false;
  const dispatched = new Set<string>();
  const { input } = options;
  const maxBytes = Math.min(input.configSnapshot.maxInputBytes, 2 * 1024 * 1024);
  const authorized = (request: IncomingMessage) => {
    const raw = request.headers["x-api-key"] ?? request.headers.authorization?.replace(/^Bearer /u, "");
    const given = Buffer.from(typeof raw === "string" ? raw : "");
    return given.length === expectedToken.length && timingSafeEqual(given, expectedToken);
  };
  const server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (!authorized(request)) { rejectedRequests++; error(response, 401, "NATIVE_AGENT_BRIDGE_CAPABILITY_REQUIRED"); return; }
      if (request.method !== "POST" || !["/v1/messages", "/v1/messages/count_tokens"].includes(url.pathname)) {
        rejectedRequests++; error(response, 403, "NATIVE_AGENT_BRIDGE_PATH_DENIED"); return;
      }
      if (fatal || options.signal.aborted) { error(response, 409, "NATIVE_AGENT_BRIDGE_STOPPED"); return; }
      const body = await readBody(request, maxBytes);
      if (!Array.isArray(body.messages) || !body.messages.length) throw new Error("NATIVE_AGENT_BRIDGE_MESSAGES_INVALID");
      if (body.tools !== undefined && (!Array.isArray(body.tools) || body.tools.some(tool => !record(tool) || !allowedTools.has(String(tool.name))))) {
        rejectedRequests++; error(response, 403, "NATIVE_AGENT_BRIDGE_TOOL_DENIED"); return;
      }
      if (Array.isArray(body.tools)) for (const tool of body.tools as Record<string, unknown>[]) {
        const kind = String(tool.name).replace("mcp__native_drafts__", "");
        const schema = NativeAgentToolSchema.options.find(candidate => candidate.shape.kind.value === kind);
        if (!schema) throw new Error("NATIVE_AGENT_BRIDGE_TOOL_SCHEMA_INVALID");
        // Preserve host constraints and strict unknown-key rejection in the model context.
        const serializedSchema: unknown = JSON.parse(JSON.stringify(z.toJSONSchema(schema.shape.args)));
        tool.input_schema = serializedSchema;
      }
      // Identity, config and routing never come from the SDK subprocess request.
      body.model = input.configSnapshot.roles.default.modelName;
      for (const key of Object.keys(body)) if (!allowedBodyFields.has(key)) delete body[key];
      if (url.pathname === "/v1/messages/count_tokens") {
        response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
        response.end(JSON.stringify({ input_tokens: Math.max(1, Math.ceil(Buffer.byteLength(JSON.stringify(body), "utf8") / 3)) }));
        return;
      }
      if (calls >= input.configSnapshot.maxCallsPerTurn) { error(response, 429, "NATIVE_AGENT_BRIDGE_CALL_LIMIT"); return; }
      body.max_tokens = Math.min(Number(body.max_tokens) || input.configSnapshot.maxOutputTokens, input.configSnapshot.maxOutputTokens);
      const fingerprint = createHash("sha256").update(JSON.stringify(body)).digest("hex");
      if (dispatched.has(fingerprint)) { fatal = true; error(response, 409, "NATIVE_AGENT_BRIDGE_REPLAY_DENIED"); options.onFailure?.(); return; }
      dispatched.add(fingerprint);
      calls++;
      const callId = randomUUID();
      await options.emit("model_call_started", { callId, ordinal: calls, role: "default", modelId: input.configSnapshot.roles.default.modelId });
      const upstream = await options.modelCall({ ownerId: input.ownerId, taskId: input.taskId, turnId: input.turnId, callId, role: "default", configSnapshot: input.configSnapshot, requestBody: body, signal: options.signal });
      if (!upstream.ok) fatal = true;
      // The gateway delivers its original JSON or original SSE bytes after accounting.
      // Never synthesize model events or reconstruct text as an Anthropic response.
      response.writeHead(upstream.status, { "content-type": upstream.headers.get("content-type") ?? "application/json", "cache-control": "no-store" });
      if (upstream.body) {
        const reader = upstream.body.getReader();
        try { while (true) {
          const next = await reader.read();
          if (next.done) break;
          if (options.signal.aborted || response.destroyed) throw new Error("NATIVE_AGENT_BRIDGE_RESPONSE_INTERRUPTED");
          response.write(next.value);
        } } finally { reader.releaseLock(); }
      }
      await options.emit("model_call_completed", { callId, status: upstream.status });
      response.end();
      if (fatal) options.onFailure?.();
    })().catch(() => { fatal = true; error(response, 502, "NATIVE_AGENT_MODEL_CALL_UNCONFIRMED"); options.onFailure?.(); });
  });
  server.requestTimeout = 120_000;
  server.headersTimeout = 10_000;
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => { server.removeListener("error", reject); resolve(); }); });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("NATIVE_AGENT_BRIDGE_BIND_FAILED");
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    token,
    get calls() { return calls; },
    get rejectedRequests() { return rejectedRequests; },
    get failed() { return fatal; },
    async close() { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); },
  };
}
