import "server-only";
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, realpath, rename, stat, unlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import { z } from "zod";
import { NativeAgentToolSchema } from "../../native-agent-contract";
import { NATIVE_AGENT_NETWORK_GUARD } from "./network-guard";
import { NATIVE_AGENT_SDK_WORKER } from "./sdk-worker";
import { createNativeAgentModelBridge } from "./model-bridge";
import { readNativeAgentSdkCheckpoint } from "./checkpoint";
import type { NativeAgentRuntimeEvent, NativeAgentSdkRuntimePorts, NativeAgentSdkTurnInput, NativeAgentSdkTurnResult } from "./types";

export type * from "./types";
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
type Manifest = { ownerId: string; taskId: string; sessionId: string | null; checkpointHash?: string | null; state: NativeAgentSdkTurnResult["state"] | "running"; turnId: string };

async function windowsGitBash(explicit?: string): Promise<string | undefined> {
  if (process.platform !== "win32") return undefined;
  const candidates = explicit ? [explicit] : (process.env.PATH ?? "").split(path.delimiter).filter(Boolean)
    .map(directory => path.resolve(directory, "..", "bin", "bash.exe"));
  for (const candidate of candidates) {
    if (path.isAbsolute(candidate) && await stat(candidate).then(value => value.isFile(), () => false)) return candidate;
  }
  throw new Error("NATIVE_AGENT_RUNTIME_WINDOWS_GIT_BASH_REQUIRED");
}
async function atomicJson(filename: string, value: unknown) {
  const temporary = filename + "." + randomUUID() + ".tmp";
  await writeFile(temporary, JSON.stringify(value), { mode: 0o600 });
  await rename(temporary, filename);
}
function freeze<T>(value: T): T {
  if (value && typeof value === "object") { Object.freeze(value); for (const nested of Object.values(value)) freeze(nested); }
  return value;
}
function validate(input: NativeAgentSdkTurnInput, ports: NativeAgentSdkRuntimePorts) {
  for (const value of [input.ownerId, input.taskId, input.turnId]) if (!/^[a-zA-Z0-9_-]{1,100}$/u.test(value)) throw new Error("NATIVE_AGENT_RUNTIME_ID_INVALID");
  const config = input.configSnapshot;
  if (!config.roles.default.modelId || !config.roles.default.modelName || !/^[a-f0-9]{64}$/u.test(config.configHash)
    || !Number.isSafeInteger(config.revision) || config.revision < 1
    || !Number.isSafeInteger(config.maxCallsPerTurn) || config.maxCallsPerTurn < 1 || config.maxCallsPerTurn > 24
    || !Number.isSafeInteger(config.maxInputBytes) || config.maxInputBytes < 1 || config.maxInputBytes > 1_048_576
    || !Number.isSafeInteger(config.maxOutputTokens) || config.maxOutputTokens < 1 || config.maxOutputTokens > 8192)
    throw new Error("NATIVE_AGENT_RUNTIME_CONFIG_INVALID");
  if (!input.prompt.trim() || Buffer.byteLength(input.prompt) > config.maxInputBytes) throw new Error("NATIVE_AGENT_RUNTIME_PROMPT_INVALID");
  if (!path.isAbsolute(ports.runtimeRoot)) throw new Error("NATIVE_AGENT_RUNTIME_DIRECTORY_INVALID");
  const relative = path.relative(process.cwd(), path.resolve(ports.runtimeRoot));
  if (!relative || !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative)) throw new Error("NATIVE_AGENT_RUNTIME_DIRECTORY_INSIDE_SOURCE");
  if (input.resumeSessionId && !/^[a-f0-9-]{36}$/iu.test(input.resumeSessionId)) throw new Error("NATIVE_AGENT_RUNTIME_SESSION_INVALID");
  if (input.resumeSessionId ? !/^[a-f0-9]{64}$/u.test(input.resumeCheckpointHash ?? "") : !!input.resumeCheckpointHash) throw new Error("NATIVE_AGENT_RUNTIME_CHECKPOINT_REQUIRED");
}

/** A claimed durable turn executes once. Unknown local receipts and incomplete sessions never replay. */
export async function runNativeAgentSdkTurn(rawInput: NativeAgentSdkTurnInput, ports: NativeAgentSdkRuntimePorts): Promise<NativeAgentSdkTurnResult> {
  validate(rawInput, ports);
  const gitBashPath = await windowsGitBash(ports.gitBashPath);
  const input = { ...rawInput, configSnapshot: freeze(structuredClone(rawInput.configSnapshot)) };
  const identity = { ownerId: input.ownerId, taskId: input.taskId, turnId: input.turnId };
  const runtimeRoot = path.resolve(ports.runtimeRoot);
  await mkdir(runtimeRoot, { recursive: true, mode: 0o700 });
  const actualRoot = await realpath(runtimeRoot);
  const normalized = (value: string) => process.platform === "win32" ? value.toLowerCase() : value;
  if ((await lstat(runtimeRoot)).isSymbolicLink() || normalized(actualRoot) !== normalized(runtimeRoot)) throw new Error("NATIVE_AGENT_RUNTIME_DIRECTORY_UNSAFE");
  const taskDirectory = path.join(runtimeRoot, digest(input.ownerId), digest(input.taskId));
  const homeDirectory = path.join(taskDirectory, "home");
  const workingDirectory = path.join(taskDirectory, "workspace");
  await mkdir(homeDirectory, { recursive: true, mode: 0o700 });
  await mkdir(workingDirectory, { recursive: true, mode: 0o700 });
  const lockPath = path.join(taskDirectory, "active.lock");
  const lock = await open(lockPath, "wx", 0o600).catch(() => { throw new Error("NATIVE_AGENT_RUNTIME_TASK_ALREADY_ACTIVE"); });
  const manifestPath = path.join(taskDirectory, "session.json");
  const turnPath = path.join(taskDirectory, "turn-" + digest(input.turnId) + ".json");
  const controller = new AbortController();
  const abort = () => controller.abort();
  input.signal?.addEventListener("abort", abort, { once: true });
  if (input.signal?.aborted) controller.abort();
  let sequence = 0;
  let toolCalls = 0;
  let sessionId: string | null = null;
  let responseText = "";
  let started = false;
  let worker: Worker | undefined;
  let childPid: number | undefined;
  let bridge: Awaited<ReturnType<typeof createNativeAgentModelBridge>> | undefined;
  let emission = Promise.resolve();
  let toolExecution = Promise.resolve();
  let toolQueueFailed = false;
  const emit = (kind: NativeAgentRuntimeEvent["kind"], payload: Record<string, unknown>) => {
    const next = emission.then(() => ports.emit({ ...identity, sequence: ++sequence, kind, payload }));
    emission = next.catch(() => { controller.abort(); });
    return next;
  };
  try {
    let previous: Manifest | undefined;
    try { previous = JSON.parse(await readFile(manifestPath, "utf8")) as Manifest; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("NATIVE_AGENT_RUNTIME_MANIFEST_INVALID"); }
    if (previous && (previous.ownerId !== input.ownerId || previous.taskId !== input.taskId)) throw new Error("NATIVE_AGENT_RUNTIME_SESSION_OWNER_MISMATCH");
    if (previous && previous.state !== "completed") throw new Error("NATIVE_AGENT_RUNTIME_PREVIOUS_TURN_UNCONFIRMED");
    if (input.resumeSessionId ? previous?.sessionId !== input.resumeSessionId : !!previous?.sessionId) throw new Error("NATIVE_AGENT_RUNTIME_RESUME_MISMATCH");
    if (input.resumeSessionId) {
      const checkpoint = await readNativeAgentSdkCheckpoint(taskDirectory, input.resumeSessionId);
      if (checkpoint !== input.resumeCheckpointHash || checkpoint !== previous?.checkpointHash) throw new Error("NATIVE_AGENT_RUNTIME_CHECKPOINT_MISMATCH");
    }
    const turn = await open(turnPath, "wx", 0o600).catch(() => { throw new Error("NATIVE_AGENT_RUNTIME_TURN_ALREADY_EXECUTED"); });
    await turn.close();
    started = true;
    sessionId = input.resumeSessionId ?? null;
    await atomicJson(manifestPath, { ...identity, sessionId, state: "running" } satisfies Manifest);
    bridge = await createNativeAgentModelBridge({ input, signal: controller.signal, emit, modelCall: ports.modelCall, onFailure: () => controller.abort() });
    const guardPath = path.join(taskDirectory, "network-guard.cjs");
    const workerPath = path.join(taskDirectory, "sdk-worker.mjs");
    await writeFile(guardPath, NATIVE_AGENT_NETWORK_GUARD, { mode: 0o600 });
    await writeFile(workerPath, NATIVE_AGENT_SDK_WORKER, { mode: 0o600 });
    const dependencyRequire = createRequire(path.join(process.cwd(), "integrations/aitoearn-agent-runtime/package.json"));
    const toolSchemas = Object.fromEntries(["read_draft", "save_draft"].map(kind => {
      const schema = NativeAgentToolSchema.options.find(candidate => candidate.shape.kind.value === kind);
      if (!schema) throw new Error("NATIVE_AGENT_RUNTIME_TOOL_SCHEMA_MISSING");
      return [kind, z.toJSONSchema(schema.shape.args)];
    }));
    const safeEnvironment: Record<string, string> & { NODE_ENV: "production" } = {
      NODE_ENV: "production",
      PATH: path.dirname(process.execPath),
      HOME: homeDirectory, USERPROFILE: homeDirectory,
      APPDATA: path.join(homeDirectory, "AppData", "Roaming"), LOCALAPPDATA: path.join(homeDirectory, "AppData", "Local"),
      TMP: taskDirectory, TEMP: taskDirectory, TMPDIR: taskDirectory,
      CLAUDE_CONFIG_DIR: path.join(homeDirectory, ".claude"),
      ANTHROPIC_BASE_URL: bridge.baseUrl, ANTHROPIC_API_KEY: bridge.token,
      NO_PROXY: "127.0.0.1", no_proxy: "127.0.0.1",
      DISABLE_TELEMETRY: "1", DISABLE_ERROR_REPORTING: "1", DISABLE_AUTOUPDATER: "1",
      // Shared pricing has no cache-write rate; use the SDK's own opt-out.
      DISABLE_PROMPT_CACHING: "1",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", ENABLE_TOOL_SEARCH: "false",
      CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(input.configSnapshot.maxOutputTokens),
      NATIVE_AGENT_BRIDGE_PORT: new URL(bridge.baseUrl).port,
      NATIVE_AGENT_NETWORK_DENIAL_FILE: path.join(taskDirectory, "network-denials.log"),
      NODE_OPTIONS: "--require " + JSON.stringify(guardPath),
    };
    if (process.env.SystemRoot) {
      safeEnvironment.SystemRoot = process.env.SystemRoot;
      const systemDirectory = path.join(process.env.SystemRoot, "System32");
      safeEnvironment.ComSpec = path.join(systemDirectory, "cmd.exe");
      safeEnvironment.PATH += path.delimiter + systemDirectory;
    }
    if (process.env.WINDIR) safeEnvironment.WINDIR = process.env.WINDIR;
    if (gitBashPath) {
      safeEnvironment.CLAUDE_CODE_GIT_BASH_PATH = gitBashPath;
      safeEnvironment.PATH += path.delimiter + path.dirname(gitBashPath) + path.delimiter + path.resolve(path.dirname(gitBashPath), "..", "usr", "bin");
    }
    worker = new Worker(workerPath, {
      env: safeEnvironment, execArgv: [],
      workerData: {
        sdkUrl: pathToFileURL(dependencyRequire.resolve("@anthropic-ai/claude-agent-sdk")).href,
        zodUrl: pathToFileURL(dependencyRequire.resolve("zod")).href,
        guardPath, workingDirectory, safeEnvironment, toolSchemas,
        nodeExecutable: process.execPath, modelName: input.configSnapshot.roles.default.modelName,
        maxTurns: input.configSnapshot.maxCallsPerTurn, resumeSessionId: input.resumeSessionId, prompt: input.prompt,
      },
    });
    let success = false;
    await new Promise<void>((resolve, reject) => {
      const activeWorker = worker!;
      const stopped = () => { activeWorker.postMessage({ type: "abort" }); reject(new Error("NATIVE_AGENT_RUNTIME_STOPPED")); };
      controller.signal.addEventListener("abort", stopped, { once: true });
      if (controller.signal.aborted) stopped();
      activeWorker.once("error", () => reject(new Error("NATIVE_AGENT_SDK_WORKER_FAILED")));
      activeWorker.once("exit", code => { controller.signal.removeEventListener("abort", stopped); if (code !== 0 || !success) reject(new Error("NATIVE_AGENT_SDK_WORKER_EXIT_UNCONFIRMED")); });
      activeWorker.on("message", (raw: unknown) => {
        void (async () => {
          if (!record(raw)) throw new Error("NATIVE_AGENT_SDK_WORKER_MESSAGE_INVALID");
          if (raw.type === "child_pid" && Number.isSafeInteger(raw.pid)) { childPid = Number(raw.pid); return; }
          if (raw.type === "child_closed" && raw.pid === childPid) { childPid = undefined; return; }
          if (raw.type === "diagnostic") { ports.diagnostic?.(String(raw.message)); return; }
          if (raw.type === "failed") throw new Error("NATIVE_AGENT_SDK_WORKER_FAILED");
          if (raw.type === "done") { if (!success) throw new Error("NATIVE_AGENT_RUNTIME_RESULT_UNCONFIRMED"); resolve(); return; }
          if (!Number.isSafeInteger(raw.id)) throw new Error("NATIVE_AGENT_SDK_WORKER_REQUEST_INVALID");
          let value: unknown = null;
          if (raw.type === "validate_tool") {
            value = NativeAgentToolSchema.safeParse({ kind: raw.kind, args: raw.args }).success && ["read_draft", "save_draft"].includes(String(raw.kind));
            if (!value) throw new Error("NATIVE_AGENT_RUNTIME_TOOL_INPUT_INVALID");
          } else if (raw.type === "tool") {
            // SDK control/validation messages stay responsive; only tool side effects
            // share this queue so a multi-tool assistant message has one active call.
            const operation = toolExecution.then(async () => {
              if (toolQueueFailed || controller.signal.aborted) throw new Error("NATIVE_AGENT_RUNTIME_TOOL_QUEUE_STOPPED");
              const parsed = NativeAgentToolSchema.parse({ kind: raw.kind, args: raw.args });
              if (parsed.kind !== "read_draft" && parsed.kind !== "save_draft") throw new Error("NATIVE_AGENT_RUNTIME_TOOL_DENIED");
              const invocationId = randomUUID();
              toolCalls++;
              await emit("tool_started", { invocationId, tool: parsed.kind, args: parsed.args });
              if (controller.signal.aborted) throw new Error("NATIVE_AGENT_RUNTIME_STOPPED");
              const context = { ...identity, invocationId, signal: controller.signal };
              const result = parsed.kind === "read_draft" ? await ports.readDraft(parsed.args, context) : await ports.saveDraft(parsed.args, context);
              if (controller.signal.aborted) throw new Error("NATIVE_AGENT_RUNTIME_TOOL_OUTCOME_UNCONFIRMED");
              if (result === undefined) throw new Error("NATIVE_AGENT_RUNTIME_TOOL_RESULT_MISSING");
              await emit("tool_completed", { invocationId, tool: parsed.kind, result });
              return result;
            });
            toolExecution = operation.then(() => {}, () => { toolQueueFailed = true; });
            value = await operation;
          } else if (raw.type === "sdk_message") {
            const message = raw.message;
            if (!record(message)) throw new Error("NATIVE_AGENT_RUNTIME_SDK_MESSAGE_INVALID");
            if (typeof message.session_id === "string" && message.session_id !== sessionId) {
              if (!/^[a-f0-9-]{36}$/iu.test(message.session_id)) throw new Error("NATIVE_AGENT_RUNTIME_SESSION_INVALID");
              sessionId = message.session_id;
              await emit("sdk_session", { sessionId });
              await atomicJson(manifestPath, { ...identity, sessionId, state: "running" } satisfies Manifest);
            }
            await emit("sdk_message", { message });
            if (message.type === "assistant" && record(message.message) && Array.isArray(message.message.content)) {
              responseText += message.message.content.filter(record).filter(block => block.type === "text").map(block => typeof block.text === "string" ? block.text : "").join("");
            }
            if (message.type === "result") { success = message.subtype === "success" && !message.is_error; if (typeof message.result === "string") responseText = message.result; }
          } else throw new Error("NATIVE_AGENT_SDK_WORKER_REQUEST_DENIED");
          activeWorker.postMessage({ type: "reply", id: raw.id, ok: true, value });
        })().catch(error => { controller.abort(); reject(error); });
      });
    });
    if (!success || !sessionId || bridge.failed) throw new Error("NATIVE_AGENT_RUNTIME_RESULT_UNCONFIRMED");
    if (childPid) throw new Error("NATIVE_AGENT_SDK_CLI_EXIT_UNCONFIRMED");
    // The SDK CLI has closed and flushed its transcript. Stop SDK host timers before hashing.
    await worker.terminate();
    worker = undefined;
    const checkpointHash = await readNativeAgentSdkCheckpoint(taskDirectory, sessionId);
    const result: NativeAgentSdkTurnResult = { state: "completed", sessionId, checkpointHash, responseText, modelCalls: bridge.calls, toolCalls };
    await emit("runtime_terminal", { state: result.state, sessionId, checkpointHash, modelCalls: result.modelCalls, toolCalls });
    await atomicJson(turnPath, result);
    await atomicJson(manifestPath, { ...identity, sessionId, checkpointHash, state: "completed" } satisfies Manifest);
    return result;
  } catch (error) {
    if (!started) throw error;
    ports.diagnostic?.(error instanceof Error ? error.message : "NATIVE_AGENT_RUNTIME_ERROR");
    controller.abort();
    const result: NativeAgentSdkTurnResult = { state: "unknown", sessionId, checkpointHash: null, responseText, modelCalls: bridge?.calls ?? 0, toolCalls, errorCode: "NATIVE_AGENT_RUNTIME_UNCONFIRMED" };
    await atomicJson(turnPath, result);
    await atomicJson(manifestPath, { ...identity, sessionId, state: "unknown" } satisfies Manifest);
    await emit("runtime_terminal", { state: "unknown", sessionId, errorCode: result.errorCode }).catch(() => {});
    return result;
  } finally {
    controller.abort();
    input.signal?.removeEventListener("abort", abort);
    if (childPid) { try { process.kill(childPid); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; } }
    if (worker) await worker.terminate();
    await bridge?.close();
    await lock.close();
    await unlink(lockPath);
  }
}
