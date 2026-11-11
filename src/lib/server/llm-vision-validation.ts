import { createHash, randomInt } from "node:crypto";
import sharp from "sharp";
import {
  LLM_MODEL_VALIDATION_MAX_AGE_MS, LlmModelValidationError, assertLlmValidationConfigurationUnchanged,
  llmModelValidationConfigurationHash, type LlmModelValidationBinding, type LlmModelValidationEvidence,
} from "../llm-model-validation-gate";
import type { ModelPoolEntry, ModelPoolSnapshot } from "../platform-configuration-contract";
import type { ChatRequest } from "../llm-proxy/types";

export const LLM_VISION_FIXTURE_VERSION = "llm-vision-three-images/1";
export const LLM_VISION_HASH_DOMAIN = "llm-vision-validation/v1";
export type VisionBinding = LlmModelValidationBinding & { image_parsing?: unknown; updated_at?: unknown };
export type VisionProbeRequest = { scope: "draft" | "saved"; modelId: string };
type Answer = { shape: string; color: string; code: string };
type SafeAnswer = { shape: string | null; color: string | null; code: string | null };
export type VisionChallengeFailure = "empty" | "not_json" | "top_schema" | "image_count" | "item_schema" | "value_mismatch";
export type VisionChallengeDiagnostics = {
  failure: VisionChallengeFailure | null;
  expected: SafeAnswer[];
  parsed: SafeAnswer[];
  matchBitmap: Array<{ shape: boolean; color: boolean; code: boolean; all: boolean }>;
  fenced: boolean;
  parseSource: "strict_json" | "fenced_diagnostic" | "none";
  responseLength: number;
  parsedImageCount: number | null;
  finishReason: string | null;
};
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu;
const fail = (code: string, message: string, status = 409): never => { throw new LlmModelValidationError(code, message, status); };

/** The client can select one existing ID and a single capability, never probe content or credentials. */
export function parseVisionProbeRequest(body: Record<string, unknown>): VisionProbeRequest {
  const scope = body.scope;
  const allowed = new Set(["scope", "model_id", "model_type", "capability", ...(scope === "draft" ? ["image_parsing"] : [])]);
  if ((scope !== "draft" && scope !== "saved") || body.capability !== "vision" || !UUID.test(String(body.model_id ?? ""))
    || (body.model_type !== undefined && body.model_type !== "text") || Object.keys(body).some(key => !allowed.has(key))
    || (scope === "draft" && body.image_parsing !== "gpt_vision")) {
    return fail("VISION_PROBE_INPUT_INVALID", "图片验证仅接受已有模型ID；候选仅允许图片解析能力gpt_vision，不接受图片、提示词、地址或密钥覆盖", 400);
  }
  return { scope, modelId: String(body.model_id) };
}

export function effectiveVisionBinding(stored: VisionBinding, scope: VisionProbeRequest["scope"]): VisionBinding {
  if (!UUID.test(String(stored.id ?? ""))) return fail("VISION_MODEL_ID_INVALID", "图片验证必须绑定已有原模型ID", 400);
  if (scope === "saved" && stored.image_parsing !== "gpt_vision") return fail("VISION_CAPABILITY_NOT_SAVED", "当前已发布模型没有gpt_vision能力；请使用仅能力候选验证");
  return { ...stored, image_parsing: "gpt_vision" };
}

/** Separate hash domain and evidence row; ordinary text validation hashes are untouched. */
export function visionConfigurationHash(binding: VisionBinding, resolvedSecret: string): string {
  if (binding.image_parsing !== "gpt_vision") return fail("VISION_CAPABILITY_UNSUPPORTED", "本次仅验证gpt_vision图片解析能力");
  return createHash("sha256").update(JSON.stringify({
    domain: LLM_VISION_HASH_DOMAIN, ordinaryConfigurationHash: llmModelValidationConfigurationHash(binding, resolvedSecret),
    capability: "vision", imageParsing: binding.image_parsing, fixtureVersion: LLM_VISION_FIXTURE_VERSION, requiredImageCount: 3,
  })).digest("hex");
}

export function assertVisionConfigurationUnchanged(before: VisionBinding, after: VisionBinding | null | undefined, ordinaryHash: string, secret: string) {
  assertLlmValidationConfigurationUnchanged(before, after, ordinaryHash, secret);
  if (before.image_parsing !== after?.image_parsing) return fail("VALIDATION_CONFIGURATION_CHANGED", "验证期间图片能力发生变化，未记录视觉证据");
}

export function assertFreshVisionEvidence(binding: VisionBinding, secret: string, evidence: LlmModelValidationEvidence | null | undefined, now = Date.now()) {
  if (!evidence || evidence.model_id !== binding.id || evidence.configuration_hash !== visionConfigurationHash(binding, secret)) {
    return fail("VISION_VALIDATION_EVIDENCE_REQUIRED", "开启图片解析前须完成同一原模型ID、当前能力候选的真实三图验证");
  }
  const at = Date.parse(String(evidence.checked_at ?? ""));
  if (!Number.isFinite(at) || at > now + 60_000 || now - at > LLM_MODEL_VALIDATION_MAX_AGE_MS) return fail("VISION_VALIDATION_EVIDENCE_EXPIRED", "图片验证证据已过期，请重新核对候选后验证");
}

/** Random answers exist only as raster pixels; neither codes nor selected colors/shapes are in text messages. */
export async function buildVisionChallenge(): Promise<{ messages: ChatRequest["messages"]; expected: Answer[]; fixtureVersion: string; fixtureSha256: string; imageCount: number; imageSha256: string[] }> {
  const shapes = ["circle", "square", "triangle"];
  const colors = [{ name: "red", hex: "#E52525" }, { name: "blue", hex: "#2356E8" }, { name: "green", hex: "#15953C" }, { name: "orange", hex: "#F48213" }, { name: "purple", hex: "#8D30C6" }];
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const expected: Answer[] = [], images: Buffer[] = [];
  for (let index = 0; index < 3; index++) {
    const shape = shapes[randomInt(shapes.length)], color = colors[randomInt(colors.length)];
    const code = Array.from({ length: 4 }, () => alphabet[randomInt(alphabet.length)]).join("");
    const geometry = shape === "circle" ? '<circle cx="160" cy="82" r="58"/>' : shape === "square" ? '<rect x="104" y="26" width="112" height="112"/>' : '<polygon points="160,20 225,140 95,140"/>';
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="240"><rect width="320" height="240" fill="white"/><g fill="${color.hex}">${geometry}</g><text x="160" y="212" text-anchor="middle" font-family="monospace" font-size="48" font-weight="bold" fill="black">${code}</text></svg>`;
    images.push(await sharp(Buffer.from(svg)).png().toBuffer());
    expected.push({ shape, color: color.name, code });
  }
  const messages: ChatRequest["messages"] = [
    { role: "system", content: 'Inspect all three supplied images in their exact supplied order. Return only strict JSON: {"images":[{"shape":"...","color":"...","code":"..."},...]}. For each image identify its large colored shape (circle, square or triangle), color (red, blue, green, orange or purple), and exact four-character uppercase code. Include exactly three objects, with no extra keys or prose. Do not guess an image you cannot see.' },
    { role: "user", content: [{ type: "text", text: "Read the three images in order." }, ...images.map(buffer => ({ type: "image_url", image_url: { url: `data:image/png;base64,${buffer.toString("base64")}` } }))] },
  ];
  return { messages, expected, fixtureVersion: LLM_VISION_FIXTURE_VERSION, fixtureSha256: createHash("sha256").update(Buffer.concat(images)).digest("hex"),
    imageCount: images.length, imageSha256: images.map(buffer => createHash("sha256").update(buffer).digest("hex")) };
}

const shapes = new Set(["circle", "square", "triangle"]);
const colors = new Set(["red", "blue", "green", "orange", "purple"]);
const finishReasons = new Set(["stop", "length", "tool_calls", "function_call", "content_filter", "end_turn", "max_tokens", "stop_sequence", "tool_use", "pause_turn", "refusal", "model_context_window_exceeded"]);
const object = (value: unknown): Record<string, unknown> | null => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
const safeAnswer = (value: unknown): SafeAnswer => {
  const row = object(value);
  return { shape: typeof row?.shape === "string" && shapes.has(row.shape) ? row.shape : null,
    color: typeof row?.color === "string" && colors.has(row.color) ? row.color : null,
    code: typeof row?.code === "string" && /^[A-Z0-9]{4}$/u.test(row.code) ? row.code : null };
};

/** Read public stop labels only. Never echo arbitrary provider strings or raw payloads. */
export function visionFinishReason(result: unknown): string | null {
  const value = object(result), raw = object(value?.raw);
  const first = Array.isArray(raw?.choices) ? object(raw.choices[0]) : null;
  const reason = first?.finish_reason ?? raw?.stop_reason ?? value?.finish_reason ?? value?.finishReason;
  return typeof reason === "string" && finishReasons.has(reason) ? reason : null;
}

/** Diagnostics expose only closed-vocabulary fields and four-character codes.
 * A fenced body may be parsed for diagnostics, but failure stays not_json and
 * can never create evidence. No prose, unexpected keys, URLs or raw text escape. */
export function diagnoseVisionChallenge(content: unknown, expected: readonly Answer[], finishReason: unknown = null): VisionChallengeDiagnostics {
  const safeExpected = expected.slice(0, 3).map(safeAnswer);
  const diagnostic: VisionChallengeDiagnostics = { failure: null, expected: safeExpected, parsed: [],
    matchBitmap: Array.from({ length: 3 }, () => ({ shape: false, color: false, code: false, all: false })),
    fenced: typeof content === "string" && /^\s*```/u.test(content), parseSource: "none",
    responseLength: typeof content === "string" ? content.length : 0, parsedImageCount: null,
    finishReason: typeof finishReason === "string" && finishReasons.has(finishReason) ? finishReason : null };
  if (typeof content !== "string" || !content.trim()) return { ...diagnostic, failure: "empty" };
  if (content.length > 4096) return { ...diagnostic, failure: "not_json" };
  let parsed: unknown;
  try { parsed = JSON.parse(content.trim()); diagnostic.parseSource = "strict_json"; }
  catch {
    diagnostic.failure = "not_json";
    const fenced = content.match(/^\s*```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n```[ \t]*$/iu);
    if (!fenced) return diagnostic;
    try { parsed = JSON.parse(fenced[1]); diagnostic.parseSource = "fenced_diagnostic"; }
    catch { return diagnostic; }
  }
  const top = object(parsed), items = Array.isArray(top?.images) ? top.images : null;
  diagnostic.parsedImageCount = items?.length ?? null;
  diagnostic.parsed = items ? items.slice(0, 3).map(safeAnswer) : [];
  diagnostic.matchBitmap = Array.from({ length: 3 }, (_, index) => {
    const actual = diagnostic.parsed[index], wanted = safeExpected[index];
    const shape = Boolean(actual?.shape && actual.shape === wanted?.shape);
    const color = Boolean(actual?.color && actual.color === wanted?.color);
    const code = Boolean(actual?.code && actual.code === wanted?.code);
    return { shape, color, code, all: shape && color && code };
  });
  if (diagnostic.failure) return diagnostic;
  if (!top || Object.keys(top).join() !== "images" || !items) return { ...diagnostic, failure: "top_schema" };
  if (items.length !== 3 || expected.length !== 3) return { ...diagnostic, failure: "image_count" };
  const validItems = items.every(item => { const row = object(item); return row && Object.keys(row).sort().join() === "code,color,shape"
    && typeof row.shape === "string" && typeof row.color === "string" && typeof row.code === "string"; });
  if (!validItems) return { ...diagnostic, failure: "item_schema" };
  if (!diagnostic.matchBitmap.every(match => match.all)) return { ...diagnostic, failure: "value_mismatch" };
  return diagnostic;
}

export function visionChallengePassed(content: string, expected: readonly Answer[]): boolean {
  return diagnoseVisionChallenge(content, expected).failure === null;
}

const parsing = (entry?: ModelPoolEntry) => String(entry?.capabilities.imageParsing || "none");
function visionEntryBinding(entry: ModelPoolEntry): string {
  const stable = (value: unknown): unknown => Array.isArray(value) ? value.map(stable) : value && typeof value === "object"
    ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, stable(child)])) : value;
  return JSON.stringify(stable({ modelName: entry.modelName, endpoint: entry.endpoint, provider: entry.provider, protocol: entry.protocol,
    credentialRef: entry.credentialRef ?? null, pricing: entry.pricing, configuration: entry.configuration,
    capabilities: { ...entry.capabilities, imageParsing: "gpt_vision" } }));
}
/** Only newly enabled vision capabilities are gated; existing ordinary model evidence is unaffected. */
export function visionCapabilityTransitions(current: ModelPoolSnapshot | null, candidate: ModelPoolSnapshot): Array<{ before?: ModelPoolEntry; after: ModelPoolEntry }> {
  return candidate.models.filter(entry => entry.kind === "agent" && entry.catalogState === "enabled" && parsing(entry) !== "none")
    .flatMap(after => { const before = current?.models.find(entry => entry.kind === "agent" && entry.id === after.id);
      return !before || parsing(before) === "none" || parsing(before) !== parsing(after) || before.catalogState !== "enabled" || visionEntryBinding(before) !== visionEntryBinding(after)
        ? [{ before, after }] : []; });
}

/** This canary only authorizes the capability toggle against the unchanged published binding.
 * Endpoint, credentials, pricing or execution changes need their own later validation workflow. */
export function visionCandidateBinding(before: ModelPoolEntry | undefined, after: ModelPoolEntry, stored: VisionBinding & Record<string, unknown>): VisionBinding {
  const id = String(after.configuration.legacyId ?? "");
  if (!before || before.id !== after.id || after.configuration.legacyTable !== "llm_models" || after.id !== `llm:${id}` || stored.id !== id || !UUID.test(id) || parsing(after) !== "gpt_vision") {
    return fail("VISION_CAPABILITY_CANDIDATE_UNSUPPORTED", "本次图片能力发布仅支持已有原LLM模型ID的gpt_vision候选");
  }
  if (String(stored.image_parsing || "none") !== parsing(before)) return fail("VISION_CAPABILITY_BINDING_CHANGED", "原模型当前图片能力与已发布基线不同，请重新核对");
  if (visionEntryBinding(before) !== visionEntryBinding(after)) return fail("VISION_CAPABILITY_BINDING_CHANGED", "本次图片证据仅适用于能力单独变更；接口、密钥、价格或执行配置变化须分别验证");
  const c = after.configuration, p = after.pricing, cap = after.capabilities;
  // Mirror the atomic LLM projection (20261019010000 + 20261030020000).
  // Missing nullable prices become null; missing context limits become defaults.
  // The publisher compares this exact final binding with the probed physical row
  // and rejects any implicit execution change rather than authorizing new params.
  return { ...stored, id, model_name: after.modelName, api_endpoint: after.endpoint,
    billing_mode: p.billingMode ?? c.billingMode ?? "credit", token_billing_enabled: c.tokenBillingEnabled ?? false,
    input_cost_per_million: p.inputCostPerMillion ?? null, output_cost_per_million: p.outputCostPerMillion ?? null, cached_cost_per_million: p.cachedCostPerMillion ?? null,
    profit_margin: c.profitMargin ?? null, max_context_rounds: c.maxContextRounds ?? 12, max_context_tokens: c.maxContextTokens ?? 64000,
    max_reply_tokens: c.maxReplyTokens ?? 4096, timeout: c.timeout ?? 300, deep_thinking_type: cap.deepThinkingType ?? stored.deep_thinking_type ?? 0,
    enable_web_search: cap.webSearch ?? stored.enable_web_search ?? false,
    api_protocol_config: c.protocolConfig ?? stored.api_protocol_config ?? {}, image_parsing: "gpt_vision" };
}
