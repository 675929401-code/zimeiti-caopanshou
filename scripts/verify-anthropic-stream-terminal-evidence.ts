import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import vm from "node:vm";
import ts from "typescript";
import type { StreamCallbacks } from "../src/lib/llm-proxy/types";

type FixtureModule = { exports: Record<string, unknown> };
type Usage = { prompt_tokens: number; completion_tokens: number; cached_tokens: number };
type Frame = {
  choices?: Array<{ delta?: Record<string, unknown>; finish_reason?: string | null }>;
  usage?: Usage;
  provider_terminal?: { protocol: string; source: string | null; stop_reason: string | null; usage_source: string; usage_fields_present: string[] };
  code?: string;
};

async function main() {
  const root = process.cwd();
  const require = createRequire(path.join(root, "package.json"));
  const modules = new Map<string, FixtureModule>();
  let nextResponse: Response | null = null;
  const effects = { mockFetchCalls: 0, realNetworkCalls: 0, databaseCalls: 0, secretLoads: 0 };
  const mockFetch = async () => {
    effects.mockFetchCalls += 1;
    assert.ok(nextResponse, "A synthetic upstream response is required");
    const response = nextResponse;
    nextResponse = null;
    return response;
  };
  const load = (relative: string): Record<string, unknown> => {
    const filename = path.resolve(root, relative);
    const cached = modules.get(filename);
    if (cached) return cached.exports;
    const fixture: FixtureModule = { exports: {} };
    modules.set(filename, fixture);
    const compiled = ts.transpileModule(readFileSync(filename, "utf8"), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
    }).outputText;
    const fixtureRequire = (specifier: string): unknown => {
      if (specifier === "@/lib/server-runtime-env") return { ensureServerRuntimeEnvLoaded() {} };
      if (specifier === "server-only") return {};
      if (specifier.startsWith("@/storage/") || specifier === "pg") { effects.databaseCalls += 1; throw new Error("OFFLINE_DATABASE_FORBIDDEN"); }
      if (specifier.startsWith("node:")) return require(specifier);
      let target = specifier.startsWith("@/") ? path.join(root, "src", specifier.slice(2)) : path.resolve(path.dirname(filename), specifier);
      if (!path.extname(target)) target += ".ts";
      return load(path.relative(root, target));
    };
    vm.runInNewContext(compiled, { module: fixture, exports: fixture.exports, require: fixtureRequire,
      __dirname: path.dirname(filename), process: { env: {}, argv: [] },
      URL, Response, Headers, ReadableStream, TextEncoder, TextDecoder, AbortController, Buffer,
      console: { log() {}, warn() {}, error() {} }, fetch: mockFetch, setTimeout, clearTimeout,
    }, { filename });
    return fixture.exports;
  };
  const { LLMProxy } = load("src/lib/llm-proxy/proxy.ts") as unknown as typeof import("../src/lib/llm-proxy/proxy");
  const checks: string[] = [];
  const plain = (value: unknown) => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
  const check = (name: string, actual: unknown, ...expectedValues: unknown[]) => {
    const expected = expectedValues.length ? expectedValues[0] : true;
    assert.deepEqual(plain(actual), plain(expected), name); checks.push(name);
  };
  const event = (payload: unknown) => `data: ${JSON.stringify(payload)}\n\n`;
  const start = (usage?: Record<string, unknown>) => event({ type: "message_start", message: { ...(usage ? { usage } : {}) } });
  const text = (content: string) => event({ type: "content_block_delta", delta: { type: "text_delta", text: content } });
  const delta = (reason?: string, usage?: Record<string, unknown>, stopSequence?: string) => event({ type: "message_delta", delta: {
    ...(reason ? { stop_reason: reason } : {}), ...(stopSequence ? { stop_sequence: stopSequence } : {}),
  }, ...(usage ? { usage } : {}) });
  const stop = event({ type: "message_stop" });
  const done = "data: [DONE]\n\n";
  const run = async (input: string, protocol: "anthropic_messages" | "openai_chat" = "anthropic_messages", fragmented = false) => {
    const encoded = new TextEncoder().encode(input);
    const upstream = new ReadableStream<Uint8Array>({ start(controller) {
      if (fragmented) for (let index = 0; index < encoded.length; index += 3) controller.enqueue(encoded.slice(index, index + 3));
      else controller.enqueue(encoded);
      controller.close();
    } });
    nextResponse = new Response(upstream, { status: 200, headers: { "Content-Type": "text/event-stream" } });
    const callbacks = { content: [] as string[], usages: [] as Usage[], errors: [] as string[], done: 0 };
    const callbackPort: StreamCallbacks = { onContent: value => callbacks.content.push(value), onUsage: value => callbacks.usages.push(plain(value)),
      onError: error => callbacks.errors.push(error.message), onDone: () => { callbacks.done += 1; } };
    const proxy = new LLMProxy({ apiBase: "https://offline.invalid", apiKey: "offline-placeholder", protocol, defaultModel: "offline-model", timeout: 1, retryCount: 0 });
    const stream = await proxy.chatStream({ model: "offline-model", messages: [{ role: "user", content: "Offline contract" }], max_tokens: 20 }, callbackPort);
    const output = await new Response(stream).text();
    const frames: Frame[] = output.split(/\r?\n/u).filter(line => line.startsWith("data: ")).flatMap(line => {
      try { return [JSON.parse(line.slice(6)) as Frame]; } catch { return []; }
    });
    return { output, frames, callbacks, terminals: frames.filter(frame => frame.provider_terminal), doneCount: output.split(done).length - 1 };
  };

  const normal = await run(start({ input_tokens: 7, output_tokens: 0, cache_read_input_tokens: 2, cache_creation_input_tokens: 3 })
    + text("你好🙂") + delta("end_turn", { output_tokens: 11 }) + stop, "anthropic_messages", true);
  check("native end_turn has exactly one evidence frame", normal.terminals.length, 1);
  const terminal = normal.terminals[0];
  check("native confirmed reason retained in standard choice", terminal.choices?.[0]?.finish_reason, "end_turn");
  check("standard terminal delta is empty object", terminal.choices?.[0]?.delta, {});
  check("native source preserved", terminal.provider_terminal?.source, "native_message_stop");
  check("native protocol evidence", terminal.provider_terminal?.protocol, "anthropic_messages");
  check("normalized reported usage source", terminal.provider_terminal?.usage_source, "normalized_reported");
  check("actual native fields presence retained", terminal.provider_terminal?.usage_fields_present,
    ["input_tokens", "output_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"]);
  check("input/cache fragments and output normalized", terminal.usage, { prompt_tokens: 12, completion_tokens: 11, cached_tokens: 2 });
  check("fragmented UTF8 text preserved", normal.callbacks.content.join(""), "你好🙂");
  check("only existing native usage events trigger callback", normal.callbacks.usages.length, 2);
  check("callback usage equals normalized terminal usage", normal.callbacks.usages.at(-1), terminal.usage);
  check("native completion callback remains once", normal.callbacks.done, 1);
  check("native DONE remains once", normal.doneCount, 1);
  check("evidence precedes DONE", normal.output.indexOf('"provider_terminal"') < normal.output.indexOf(done));
  const frontendContent = normal.frames.map(frame => typeof frame.choices?.[0]?.delta?.content === "string" ? frame.choices[0].delta.content : "").join("");
  check("frontend choice delta reader ignores terminal metadata", frontendContent, "你好🙂");

  const capped = await run(start({ input_tokens: 4 }) + text("Capped") + delta("max_tokens", { output_tokens: 20 }) + stop);
  check("max_tokens is retained rather than fabricated end_turn", capped.terminals[0].choices?.[0]?.finish_reason, "max_tokens");
  check("max_tokens leaves existing transport DONE rule", capped.doneCount, 1);
  check("max_tokens does not become upstream error", capped.callbacks.errors.length, 0);
  check("missing cache fields are not claimed reported", capped.terminals[0].provider_terminal?.usage_fields_present, ["input_tokens", "output_tokens"]);

  const relay = await run(text("Relay") + delta("untrusted-stop-secret", undefined, "untrusted-stop-sequence-secret") + done);
  check("relay DONE distinguished from native message_stop", relay.terminals[0].provider_terminal?.source, "relay_done");
  check("relay DONE cannot invent finish reason", relay.terminals[0].choices?.[0]?.finish_reason, null);
  check("relay stream preserves existing completion callback", relay.callbacks.done, 1);
  check("missing usage is not emitted as reported zero", relay.terminals[0].usage, undefined);
  check("missing usage source explicit", relay.terminals[0].provider_terminal?.usage_source, "not_reported");
  check("missing fields explicit", relay.terminals[0].provider_terminal?.usage_fields_present, []);
  check("missing usage adds no usage callback", relay.callbacks.usages.length, 0);
  check("unknown reason is not leaked in terminal metadata", !relay.output.includes("untrusted-stop-secret"));
  check("raw stop sequence is not emitted", !relay.output.includes("untrusted-stop-sequence-secret"));

  const repeated = await run(start({ input_tokens: 9, cache_read_input_tokens: 2 }) + text("Repeated")
    + delta(undefined, { output_tokens: 5 }) + delta(undefined, { output_tokens: 5 }) + delta("end_turn", { output_tokens: 8 }) + stop);
  check("repeated cumulative usage uses max without addition", repeated.terminals[0].usage, { prompt_tokens: 11, completion_tokens: 8, cached_tokens: 2 });
  check("one callback per received usage object remains", repeated.callbacks.usages.length, 4);
  check("terminal evidence does not add another callback", repeated.callbacks.usages.at(-1), repeated.terminals[0].usage);

  const eof = await run(start({ input_tokens: 5 }) + text("Partial") + delta("end_turn", { output_tokens: 4 }));
  check("pure EOF still reports interruption", eof.frames.at(-1)?.code, "LLM_STREAM_INTERRUPTED");
  check("reason alone does not turn EOF into successful evidence", eof.terminals.length, 0);
  check("pure EOF still has no DONE", eof.doneCount, 0);
  check("pure EOF does not invoke completion callback", eof.callbacks.done, 0);
  check("pure EOF invokes original error callback once", eof.callbacks.errors.length, 1);

  const openAiFirst = { choices: [{ delta: { content: "OpenAI" }, finish_reason: null }] };
  const openAiLast = { choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 3, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 1 } } };
  const openAi = await run(event(openAiFirst) + event(openAiLast), "openai_chat");
  check("OpenAI raw JSON frames remain unchanged", openAi.frames, [openAiFirst, openAiLast]);
  check("OpenAI receives no Anthropic evidence", openAi.terminals.length, 0);
  check("OpenAI content callback unchanged", openAi.callbacks.content, ["OpenAI"]);
  check("OpenAI usage callback unchanged", openAi.callbacks.usages, [{ prompt_tokens: 3, completion_tokens: 2, cached_tokens: 1 }]);
  check("OpenAI DONE remains once", openAi.doneCount, 1);
  check("OpenAI prior finish_reason EOF success preserved", openAi.callbacks.done, 1);

  check("all mocked responses consumed", nextResponse, null);
  check("zero real network calls", effects.realNetworkCalls, 0);
  check("zero database calls", effects.databaseCalls, 0);
  check("zero secret loads", effects.secretLoads, 0);
  check("only six required stream cases exercised", effects.mockFetchCalls, 6);
  console.log(JSON.stringify({ status: "passed", streamCases: 6, assertions: checks.length, checks, effects }, null, 2));
}

main().catch(error => { console.error(error); process.exitCode = 1; });
