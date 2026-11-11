import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtemp, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runNativeAgentSdkTurn, type NativeAgentRuntimeEvent, type NativeAgentRuntimeModelCall, type NativeAgentSdkRuntimePorts } from "../src/lib/server/native-agent-runtime";
import type { NativeAgentRuntimeConfigSnapshot } from "../src/lib/native-agent-runtime-contract";
import { createNativeAgentModelBridge } from "../src/lib/server/native-agent-runtime/model-bridge";
import { createNativeAgentModelGateway, type NativeAgentModelGatewayPorts } from "../src/lib/server/native-agent-model-gateway";
import type { LlmRequestAttemptRecord, LlmRequestAttemptStore } from "../src/lib/llm-request-idempotency";

async function main() {
const runtimeRoot = await mkdtemp(path.join(os.tmpdir(), "zimeiti-native-sdk-"));
const identity = { ownerId: randomUUID(), taskId: randomUUID() };
const sourceDraft = randomUUID();
const savedDraft = randomUUID();
const config: NativeAgentRuntimeConfigSnapshot = {
  revision: 1, configHash: "a".repeat(64),
  roles: Object.fromEntries(["default", "background", "think"].map(role => [role, { modelId: `pm_${"a".repeat(24)}`, modelName: "claude-sonnet-4-5-20250929" }])) as NativeAgentRuntimeConfigSnapshot["roles"],
  maxCallsPerTurn: 8, maxOutputTokens: 1024, maxInputBytes: 262144, maxCreditsPerTurn: "50.000000",
};
const events: NativeAgentRuntimeEvent[] = [];
const diagnostics: string[] = [];
const modelRequests: NativeAgentRuntimeModelCall[] = [];
let reads = 0;
let saves = 0;
let stage = 0;
const saveArgs = { expectedRevision: 0, expectedMetadataRevision: 0, collectionId: null, contentType: "image", title: "SDK改写草稿", body: "经读取真实工具结果后保存的改写正文", topics: [], assetIds: [], platforms: [] };

function modelResponse(body: Record<string, unknown>, content: Record<string, unknown> | Record<string, unknown>[], stopReason: "tool_use" | "end_turn") {
  const blocks = Array.isArray(content) ? content : [content];
  const message = { id: `msg_${randomUUID().replaceAll("-", "")}`, type: "message", role: "assistant", model: config.roles.default.modelName,
    content: blocks, stop_reason: stopReason, stop_sequence: null, usage: { input_tokens: 100, output_tokens: 40 } };
  if (!body.stream) return Response.json(message);
  const event = (name: string, value: unknown) => `event: ${name}\ndata: ${JSON.stringify(value)}\n\n`;
  let sse = event("message_start", { type: "message_start", message: { ...message, content: [], stop_reason: null, usage: { input_tokens: 100, output_tokens: 0 } } });
  for (const [index, block] of blocks.entries()) {
    const start = block.type === "tool_use" ? { ...block, input: {} } : { type: "text", text: "" };
    const delta = block.type === "tool_use" ? { type: "input_json_delta", partial_json: JSON.stringify(block.input) } : { type: "text_delta", text: block.text };
    sse += event("content_block_start", { type: "content_block_start", index, content_block: start })
      + event("content_block_delta", { type: "content_block_delta", index, delta })
      + event("content_block_stop", { type: "content_block_stop", index });
  }
  sse += event("message_delta", { type: "message_delta", delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: 40 } })
    + event("message_stop", { type: "message_stop" });
  return new Response(sse, { headers: { "content-type": "text/event-stream" } });
}
const ports: NativeAgentSdkRuntimePorts = {
  runtimeRoot,
  gitBashPath: process.platform === "win32" ? "E:\\大模型聚合套壳\\Git\\bin\\bash.exe" : undefined,
  async emit(event) { events.push(structuredClone(event)); },
  diagnostic(message) { diagnostics.push(message); },
  async readDraft(args, context) {
    assert.equal(context.ownerId, identity.ownerId);
    assert.ok(events.some(event => event.kind === "tool_started" && event.payload.invocationId === context.invocationId));
    reads++;
    assert.equal(args.draftId, reads === 1 ? sourceDraft : savedDraft);
    return { id: args.draftId, revision: 1, metadataRevision: 1, title: reads === 1 ? "自有原草稿" : saveArgs.title, body: reads === 1 ? "待改写原正文" : saveArgs.body };
  },
  async saveDraft(args, context) {
    assert.equal(context.ownerId, identity.ownerId);
    assert.equal(reads, 1);
    assert.deepEqual(args, saveArgs);
    saves++;
    return { id: savedDraft, revision: 1, metadataRevision: 1, title: args.title, body: args.body };
  },
  async modelCall(request) {
    try {
    assert.equal(request.ownerId, identity.ownerId);
    assert.equal(request.taskId, identity.taskId);
    assert.equal(request.role, "default");
    assert.equal(request.requestBody.model, config.roles.default.modelName);
    const declaredTools = request.requestBody.tools as { name: string; input_schema: Record<string, unknown> }[];
    assert.deepEqual(declaredTools.map(tool => tool.name).sort(), ["mcp__native_drafts__read_draft", "mcp__native_drafts__save_draft"]);
    for (const tool of declaredTools) assert.equal(tool.input_schema.additionalProperties, false);
    assert.ok(events.some(event => event.kind === "model_call_started" && event.payload.callId === request.callId));
    modelRequests.push(request);
    const transcript = JSON.stringify(request.requestBody.messages);
    const tool = (name: string, input: unknown) => modelResponse(request.requestBody, { type: "tool_use", id: `toolu_${stage}`, name: `mcp__native_drafts__${name}`, input }, "tool_use");
    switch (stage++) {
      case 0: return tool("read_draft", { draftId: sourceDraft });
      case 1: assert.match(transcript, /待改写原正文/); return tool("save_draft", saveArgs);
      case 2: assert.match(transcript, new RegExp(savedDraft)); return modelResponse(request.requestBody, { type: "text", text: "草稿已保存。" }, "end_turn");
      case 3: assert.match(transcript, new RegExp(savedDraft)); return tool("read_draft", { draftId: savedDraft });
      case 4: assert.match(transcript, /经读取真实工具结果后保存的改写正文/); return modelResponse(request.requestBody, { type: "text", text: "刷新后已恢复会话并读取保存草稿。" }, "end_turn");
      default: throw new Error("Unexpected model replay");
    }
    } catch (error) { diagnostics.push(`Fixture model assertion: ${error instanceof Error ? error.message : "unknown"}`); throw error; }
  },
};

async function files(directory: string): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name);
    result.push(...entry.isDirectory() ? await files(filename) : [filename]);
  }
  return result;
}

try {
  const turnId = randomUUID();
  const timeout = AbortSignal.timeout(60_000);
  const first = await runNativeAgentSdkTurn({ ...identity, turnId, configSnapshot: config, prompt: `读取草稿 ${sourceDraft}，改写后保存为新草稿。`, signal: timeout }, ports);
  if (first.state !== "completed") throw new Error(`SDK first turn ${JSON.stringify(first)}; diagnostics=${diagnostics.join(" ").slice(-6000)}`);
  assert.equal(first.modelCalls, 3);
  assert.equal(first.toolCalls, 2);
  assert.equal(saves, 1);
  assert.ok(first.sessionId);
  assert.match(first.checkpointHash!, /^[a-f0-9]{64}$/u);
  await assert.rejects(runNativeAgentSdkTurn({ ...identity, turnId, configSnapshot: config, prompt: "再次提交原turn", resumeSessionId: first.sessionId!, resumeCheckpointHash: first.checkpointHash! }, ports), /TURN_ALREADY_EXECUTED/);
  // A fresh invocation uses only persisted SDK session data and the host session binding.
  const second = await runNativeAgentSdkTurn({ ...identity, turnId: randomUUID(), configSnapshot: config, prompt: "刷新后继续，重新读取刚才保存的新草稿。", resumeSessionId: first.sessionId!, resumeCheckpointHash: first.checkpointHash!, signal: AbortSignal.timeout(60_000) }, { ...ports });
  if (second.state !== "completed") throw new Error(`SDK resume ${JSON.stringify(second)}; diagnostics=${diagnostics.join(" ").slice(-6000)}`);
  assert.equal(second.sessionId, first.sessionId);
  assert.equal(second.modelCalls, 2);
  assert.equal(reads, 2);
  assert.equal(saves, 1);
  assert.equal(modelRequests.length, 5);
  await assert.rejects(runNativeAgentSdkTurn({ ...identity, ownerId: randomUUID(), turnId: randomUUID(), configSnapshot: config, prompt: "伪造他人resume", resumeSessionId: first.sessionId!, resumeCheckpointHash: second.checkpointHash! }, ports), /RESUME_MISMATCH/);
  await assert.rejects(runNativeAgentSdkTurn({ ...identity, turnId: randomUUID(), configSnapshot: config, prompt: "错误会话", resumeSessionId: randomUUID(), resumeCheckpointHash: second.checkpointHash! }, ports), /RESUME_MISMATCH/);
  await assert.rejects(runNativeAgentSdkTurn({ ...identity, turnId: randomUUID(), configSnapshot: config, prompt: "源码内运行目录" }, { ...ports, runtimeRoot: path.join(process.cwd(), ".codex-evidence") }), /DIRECTORY_INSIDE_SOURCE/);
  const generated = await files(runtimeRoot);
  assert.ok(generated.some(filename => filename.endsWith(".jsonl")), "Real SDK persisted a resumable session");
  const denials = generated.filter(filename => filename.endsWith("network-denials.log"));
  for (const filename of denials) assert.equal(await readFile(filename, "utf8"), "", "SDK attempted a forbidden network connection");
  const guardPath = generated.find(filename => filename.endsWith("network-guard.cjs"));
  assert.ok(guardPath);
  const denialFile = path.join(runtimeRoot, "guard-denials.log");
  const guardCheck = spawnSync(process.execPath, ["--require", guardPath!, "-e", `const net=require('node:net'),tls=require('node:tls'),dns=require('node:dns'); let denied=0; for(const action of [()=>net.connect({host:'203.0.113.1',port:443}),()=>tls.connect({host:'example.invalid',port:443}),()=>dns.lookup('example.invalid')]) {try{action()}catch(error){if(error.message==='NATIVE_AGENT_EXTERNAL_NETWORK_DENIED')denied++;else throw error;}} if(denied!==3)process.exitCode=1;`], { env: { NODE_ENV: "production", NATIVE_AGENT_BRIDGE_PORT: "1", NATIVE_AGENT_NETWORK_DENIAL_FILE: denialFile }, encoding: "utf8", windowsHide: true });
  assert.equal(guardCheck.status, 0, guardCheck.stderr);
  assert.equal((await readFile(denialFile, "utf8")).trim().split("\n").length, 3);

  let bridgeDispatches = 0;
  const bridge = await createNativeAgentModelBridge({ input: { ...identity, turnId: randomUUID(), configSnapshot: config, prompt: "桥白名单" }, signal: new AbortController().signal, emit: async () => {},
    async modelCall(call) { bridgeDispatches++; assert.equal(call.ownerId, identity.ownerId); assert.equal(call.requestBody.model, config.roles.default.modelName); assert.equal(call.requestBody.ownerId, undefined); return Response.json({ untouched: true }); } });
  try {
    assert.equal((await fetch(`${bridge.baseUrl}/v1/messages`, { method: "POST", body: "{}" })).status, 401);
    assert.equal((await fetch(`${bridge.baseUrl}/arbitrary-url`, { method: "POST", headers: { "x-api-key": bridge.token }, body: "{}" })).status, 403);
    const request = { model: "untrusted-model", ownerId: "untrusted-owner", messages: [{ role: "user", content: "fixture" }], max_tokens: 2000 };
    const response = await fetch(`${bridge.baseUrl}/v1/messages`, { method: "POST", headers: { "x-api-key": bridge.token }, body: JSON.stringify(request) });
    assert.deepEqual(await response.json(), { untouched: true });
    assert.equal((await fetch(`${bridge.baseUrl}/v1/messages`, { method: "POST", headers: { "x-api-key": bridge.token }, body: JSON.stringify(request) })).status, 409);
    assert.equal(bridgeDispatches, 1);
  } finally { await bridge.close(); }

  let uncertainWrites = 0;
  const uncertainIdentity = { ownerId: randomUUID(), taskId: randomUUID() };
  const uncertainPorts: NativeAgentSdkRuntimePorts = { ...ports, emit: async () => {},
    async modelCall(call) { return modelResponse(call.requestBody, { type: "tool_use", id: "toolu_uncertain", name: "mcp__native_drafts__save_draft", input: saveArgs }, "tool_use"); },
    async saveDraft() { uncertainWrites++; throw new Error("Fixture write outcome unknown"); } };
  const uncertain = await runNativeAgentSdkTurn({ ...uncertainIdentity, turnId: randomUUID(), configSnapshot: config, prompt: "保存草稿后模拟连接中断", signal: AbortSignal.timeout(30_000) }, uncertainPorts);
  assert.equal(uncertain.state, "unknown");
  assert.equal(uncertainWrites, 1);
  await assert.rejects(runNativeAgentSdkTurn({ ...uncertainIdentity, turnId: randomUUID(), configSnapshot: config, prompt: "不能自动重放未知写入", resumeSessionId: uncertain.sessionId ?? undefined, resumeCheckpointHash: uncertain.sessionId ? "c".repeat(64) : undefined }, uncertainPorts), /PREVIOUS_TURN_UNCONFIRMED/);
  assert.equal(uncertainWrites, 1);
  const attemptRecords = new Map<string, LlmRequestAttemptRecord>();
  const hash = (value: string) => createHash("sha256").update(value).digest("hex");
  const attempts: LlmRequestAttemptStore = {
    async claim(request) {
      const previous = attemptRecords.get(request.clientRequestId);
      if (previous) throw new Error("Joint fixture forbids a duplicate provider attempt");
      const stamp = new Date().toISOString();
      const record: LlmRequestAttemptRecord = { recordId: hash(`${request.userId}\u0000${request.clientRequestId}`), userId: request.userId,
        clientRequestId: request.clientRequestId, payloadFingerprint: request.payloadFingerprint, state: "running", attemptNo: 1,
        leaseOwner: request.leaseOwner, leaseToken: 1, leaseExpiresAt: "2099-01-01T00:00:00Z", providerCallStartedAt: null,
        httpStatus: null, responseHeaders: {}, responseBody: null, responseFingerprint: null, resultReference: null, errorCode: null, errorMessage: null, createdAt: stamp, updatedAt: stamp };
      attemptRecords.set(request.clientRequestId, record);
      return { action: "execute", execution: { record, leaseOwner: request.leaseOwner, leaseToken: 1 } };
    },
    async markProviderCallStarted(execution) { const record = { ...execution.record, providerCallStartedAt: new Date().toISOString() }; attemptRecords.set(record.clientRequestId, record); return { ...execution, record }; },
    async finalize(request) {
      const record = { ...request.execution.record, state: request.state, httpStatus: request.httpStatus ?? null, responseHeaders: request.responseHeaders ?? {},
        responseBody: request.responseBody ?? null, responseFingerprint: request.responseFingerprint ?? null, resultReference: request.resultReference ?? null,
        errorCode: request.errorCode ?? null, errorMessage: request.errorMessage ?? null };
      attemptRecords.set(record.clientRequestId, record); return record;
    },
  };
  let jointProviders = 0;
  let jointSettlements = 0;
  let jointReads = 0;
  let jointSaves = 0;
  const gatewayPorts: NativeAgentModelGatewayPorts = {
    attempts,
    async authorize(context) { return { ownerId: context.ownerId, taskId: context.taskId, turnId: context.turnId, configHash: config.configHash,
      protocol: "anthropic_messages", protocolValidated: true, publicModelId: config.roles.default.modelId, providerModelId: config.roles.default.modelName,
      maxInputTokens: 100000, maxOutputTokens: config.maxOutputTokens, maxCredits: 50,
      pricing: { publicModelId: config.roles.default.modelId, internalModelId: "fixture-owned-model", modelName: config.roles.default.modelName,
        config: { inputCostPerMillion: 10, outputCostPerMillion: 30, cachedCostPerMillion: 1, profitMargin: 50, creditsPerYuan: 50,
          tokenRoundingEnabled: false, tokenRoundingUnit: 0, tokenRoundingMin: 100, tokenRoundingMax: 10000 },
        priceSnapshot: { source: "explicit-sdk-gateway-fixture", input: 10, output: 30, cached: 1 } } }; },
    accounting: {
      async quote() { return 1; },
      async reserve(request) { return { recordId: request.execution.record.recordId, leaseOwner: request.execution.leaseOwner, leaseToken: request.execution.leaseToken, amount: request.budget.amount }; },
      async settle() { jointSettlements++; return { operationId: `fixture-joint-wallet-${jointSettlements}`, creditsCharged: 0.04 }; },
      async release() {},
    },
    transport: { async send({ request }) {
      const ordinal = jointProviders++;
      if (ordinal === 0) return modelResponse(request as unknown as Record<string, unknown>, { type: "tool_use", id: "toolu_joint_read", name: "mcp__native_drafts__read_draft", input: { draftId: sourceDraft } }, "tool_use");
      if (ordinal === 1) { assert.match(JSON.stringify(request.messages), /联合网关原草稿/); return modelResponse(request as unknown as Record<string, unknown>, { type: "tool_use", id: "toolu_joint_save", name: "mcp__native_drafts__save_draft", input: saveArgs }, "tool_use"); }
      return modelResponse(request as unknown as Record<string, unknown>, { type: "text", text: "联合网关草稿已保存并结算。" }, "end_turn");
    } },
    async freezeTurn() {},
  };
  const gateway = createNativeAgentModelGateway(gatewayPorts);
  const jointPorts: NativeAgentSdkRuntimePorts = { ...ports,
    async modelCall(call) {
      try {
        const result = await gateway.call({ context: { ownerId: call.ownerId, taskId: call.taskId, turnId: call.turnId, callId: call.callId,
          configHash: call.configSnapshot.configHash, modelId: call.configSnapshot.roles.default.modelId }, request: call.requestBody, signal: call.signal });
        return new Response(result.delivery.body, { headers: { "content-type": result.delivery.contentType } });
      } catch (error) {
        const system = call.requestBody.system;
        const tools = call.requestBody.tools as Record<string, unknown>[];
        diagnostics.push(`Joint gateway failure ${error instanceof Error ? error.message : "unknown"}; keys=${JSON.stringify({ top: Object.keys(call.requestBody), system: Array.isArray(system) ? system.map(block => Object.keys(block)) : typeof system, tools: tools.map(tool => Object.keys(tool)) })}`);
        throw error;
      }
    },
    async readDraft(args) { assert.equal(jointSettlements, 1); jointReads++; return { id: args.draftId, revision: 1, metadataRevision: 1, body: "联合网关原草稿" }; },
    async saveDraft(args) { assert.equal(jointSettlements, 2); jointSaves++; return { id: savedDraft, revision: 1, metadataRevision: 1, body: args.body }; },
  };
  const joint = await runNativeAgentSdkTurn({ ...identity, turnId: randomUUID(), configSnapshot: config, prompt: "联合网关：读取原草稿，改写并保存。", resumeSessionId: second.sessionId!, resumeCheckpointHash: second.checkpointHash!, signal: AbortSignal.timeout(30000) }, jointPorts);
  if (joint.state !== "completed") throw new Error(`SDK/gateway joint ${JSON.stringify(joint)}; diagnostics=${diagnostics.join(" ").slice(-6000)}`);
  assert.deepEqual({ jointProviders, jointSettlements, jointReads, jointSaves }, { jointProviders: 3, jointSettlements: 3, jointReads: 1, jointSaves: 1 });
  const sessionFile = (await files(runtimeRoot)).find(filename => path.basename(filename) === joint.sessionId + ".jsonl");
  assert.ok(sessionFile);
  const actualSession = await readFile(sessionFile!);
  assert.equal(joint.checkpointHash, hash(actualSession.toString("utf8")));
  await assert.rejects(runNativeAgentSdkTurn({ ...identity, turnId: randomUUID(), configSnapshot: config, prompt: "缺少checkpoint", resumeSessionId: joint.sessionId! }, jointPorts), /CHECKPOINT_REQUIRED/);
  await rename(sessionFile!, sessionFile! + ".fixture-hidden");
  try {
    await assert.rejects(runNativeAgentSdkTurn({ ...identity, turnId: randomUUID(), configSnapshot: config, prompt: "checkpoint文件缺失", resumeSessionId: joint.sessionId!, resumeCheckpointHash: joint.checkpointHash! }, jointPorts), /CHECKPOINT_MISSING/);
  } finally { await rename(sessionFile! + ".fixture-hidden", sessionFile!); }
  await writeFile(sessionFile!, Buffer.concat([actualSession, Buffer.from("\n")]));
  try {
    await assert.rejects(runNativeAgentSdkTurn({ ...identity, turnId: randomUUID(), configSnapshot: config, prompt: "checkpoint已被篡改", resumeSessionId: joint.sessionId!, resumeCheckpointHash: joint.checkpointHash! }, jointPorts), /CHECKPOINT_MISMATCH/);
  } finally { await writeFile(sessionFile!, actualSession); }
  assert.equal(jointProviders, 3);
  async function multipleToolMessage(failRead: boolean) {
    const multiIdentity = { ownerId: randomUUID(), taskId: randomUUID() };
    const trace: string[] = [];
    let providers = 0;
    let settlements = 0;
    let activeTool: string | null = null;
    let startedTools = 0;
    let saved = 0;
    const multiGateway = createNativeAgentModelGateway({ ...gatewayPorts,
      accounting: { ...gatewayPorts.accounting, async settle() { settlements++; trace.push(`wallet-settled-${settlements}`); return { operationId: `fixture-multi-${settlements}`, creditsCharged: 0.04 }; } },
      transport: { async send({ request }) {
        if (providers++ === 0) return modelResponse(request as unknown as Record<string, unknown>, [
          { type: "tool_use", id: "toolu_multi_read", name: "mcp__native_drafts__read_draft", input: { draftId: sourceDraft } },
          { type: "tool_use", id: "toolu_multi_save", name: "mcp__native_drafts__save_draft", input: saveArgs },
        ], "tool_use");
        assert.match(JSON.stringify(request.messages), /multi-read-result/);
        assert.match(JSON.stringify(request.messages), /multi-save-result/);
        return modelResponse(request as unknown as Record<string, unknown>, { type: "text", text: "双工具按顺序完成。" }, "end_turn");
      } },
    });
    const multiPorts: NativeAgentSdkRuntimePorts = { ...ports,
      async emit(event) {
        if (event.kind === "tool_started") {
          // Mirrors the durable begin-call rule: a second started tool is forbidden.
          assert.equal(activeTool, null, "A second tool entered the durable active-call slot");
          activeTool = String(event.payload.invocationId);
          startedTools++;
        } else if (event.kind === "tool_completed") {
          assert.equal(event.payload.invocationId, activeTool);
          activeTool = null;
        }
      },
      async modelCall(call) {
        const result = await multiGateway.call({ context: { ownerId: call.ownerId, taskId: call.taskId, turnId: call.turnId, callId: call.callId,
          configHash: call.configSnapshot.configHash, modelId: call.configSnapshot.roles.default.modelId }, request: call.requestBody, signal: call.signal });
        return new Response(result.delivery.body, { headers: { "content-type": result.delivery.contentType } });
      },
      async readDraft(args, context) {
        assert.equal(context.ownerId, multiIdentity.ownerId);
        assert.equal(settlements, 1, "Tool ran before the model wallet settlement");
        trace.push("read-start");
        await new Promise(resolve => setTimeout(resolve, 40));
        if (failRead) { trace.push("read-failed"); throw new Error("Fixture first tool failed"); }
        trace.push("read-end");
        return { id: args.draftId, revision: 1, body: "multi-read-result" };
      },
      async saveDraft(_args, context) {
        assert.equal(context.ownerId, multiIdentity.ownerId);
        assert.equal(settlements, 1, "Tool ran before the model wallet settlement");
        assert.ok(trace.includes("read-end"));
        trace.push("save-start"); saved++; trace.push("save-end");
        return { id: savedDraft, revision: 1, body: "multi-save-result" };
      },
    };
    const result = await runNativeAgentSdkTurn({ ...multiIdentity, turnId: randomUUID(), configSnapshot: config,
      prompt: "一次回复请求读取和保存两个草稿工具，保持原工具顺序。", signal: AbortSignal.timeout(30000) }, multiPorts);
    if (failRead) {
      assert.equal(result.state, "unknown");
      assert.equal(saved, 0);
      assert.equal(startedTools, 1);
      assert.deepEqual(trace, ["wallet-settled-1", "read-start", "read-failed"]);
    } else {
      if (result.state !== "completed") throw new Error(`SDK multiple tools ${JSON.stringify(result)}; diagnostics=${diagnostics.join(" ").slice(-3000)}`);
      assert.equal(result.toolCalls, 2);
      assert.equal(saved, 1);
      assert.equal(startedTools, 2);
      assert.equal(activeTool, null);
      assert.deepEqual(trace, ["wallet-settled-1", "read-start", "read-end", "save-start", "save-end", "wallet-settled-2"]);
    }
    return { providers, settlements, startedTools, saves: saved };
  }
  const multipleTools = await multipleToolMessage(false);
  const failedToolQueue = await multipleToolMessage(true);
  console.log(JSON.stringify({ ok: true, sdkVersion: "0.2.33", checks: ["real SDK MCP read -> tool feedback -> save -> completion", "durable event precedes model/tool dispatch", "same turn rejected without replay", "fresh invocation resumes persisted SDK transcript", "resumed read returns saved draft", "only default frozen model and two strict MCP tools", "owner/session forgery and source-local runtime directory denied", "SDK subprocess TCP/TLS/DNS external access blocked", "bridge capability/path/identity/model/replay constraints", "unknown save outcome blocks subsequent replay", "actual gateway parses SDK system/tools and delivers original SSE after fake settlement", "joint read/save happen after each model settlement", "SDK-native prompt caching opt-out avoids unsupported cache write", "checkpoint hashes actual SDK session.jsonl and refuses missing/tampered resume", "one real SDK assistant message with two MCP tools occupies one durable call slot in order", "failure of the first queued MCP tool prevents the queued save"], modelCalls: modelRequests.length, readCalls: reads, saveCalls: saves, jointProviders, jointSettlements, jointReads, jointSaves, multipleTools, failedToolQueue, externalNetworkRequests: 0, paidCalls: 0, browserAcceptance: false }, null, 2));
} finally {
  const target = path.resolve(runtimeRoot);
  assert.ok(target.startsWith(`${path.resolve(os.tmpdir())}${path.sep}`) && path.basename(target).startsWith("zimeiti-native-sdk-"));
  await rm(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
