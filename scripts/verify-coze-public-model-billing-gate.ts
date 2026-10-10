import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const source = readFileSync(resolve(process.cwd(), "src/app/api/chat/route.ts"), "utf8");
const idempotencySource = readFileSync(resolve(process.cwd(), "src/lib/llm-request-idempotency.ts"), "utf8");

function requireSource(pattern: RegExp, label: string): void {
  if (!pattern.test(source)) throw new Error(`Missing Coze billing invariant: ${label}`);
}

function forbidSource(pattern: RegExp, label: string): void {
  if (pattern.test(source)) throw new Error(`Forbidden Coze billing bypass: ${label}`);
}

requireSource(/\.from\("agents"\)[\s\S]*?\.eq\("bot_id",\s*botId\)/u, "botId resolves a server agent");
requireSource(/String\(serverAgent\.model_id[\s\S]*?\.from\("llm_models"\)/u, "agent model_id resolves an LLM model");
requireSource(/\.eq\("is_active",\s*true\)[\s\S]*?\.neq\("is_hidden",\s*true\)[\s\S]*?\.neq\("user_access",\s*"hidden"\)/u, "model must be published");
requireSource(/getSelectedModelBillingSnapshot\(publicModelId,\s*modelRow\)/u, "immutable public-model price snapshot");
requireSource(/COZE_MODEL_TOKEN_PRICING_NOT_READY/u, "incomplete model token pricing fails closed");
requireSource(/baseFeeRmb[\s\S]*?serverAgent\.base_fee[\s\S]*?baseFeeCredits/u, "base fee is server-owned");
requireSource(/fingerprintLlmRequest\([\s\S]*?publicModelId:[\s\S]*?baseFeeCredits/u, "claim fingerprint binds price identity");
requireSource(/const terminalFrames: string\[\][\s\S]*?terminalFrames\.push\(frame\)/u, "terminal SSE frames are buffered");
requireSource(/COZE_UPSTREAM_INCOMPLETE[\s\S]*?LLM_BILLING_FAILED/u, "upstream and settlement failures are fail-closed");
requireSource(/settle:\s*async \(\{ usage, fullContent \}\) => settleLlmUsage\([\s\S]*?isAdmin:\s*userRole === "admin"/u, "Coze settlement records the authenticated audit role without a billing exemption");
forbidSource(/const \{[^\n]*\bbaseFee\b/u, "client baseFee destructuring");
forbidSource(/\bdeductCredits(?:WithAgentBilling)?\s*\(/u, "route-level wallet bypass");
forbidSource(/\brecordRevenue\s*\(/u, "route-level revenue side channel");

const streamStart = source.indexOf("function createBufferedCozeDeliveryStream");
const streamEnd = source.indexOf("export async function POST", streamStart);
if (streamStart < 0 || streamEnd <= streamStart) {
  throw new Error("Missing Coze billing invariant: buffered delivery function region");
}
const streamRegion = source.slice(streamStart, streamEnd);
const orderedMarkers = [
  "settlement = await options.settle",
  "await options.persist",
  "for (const frame of bufferedFrames)",
  "event: billing.completed",
  "for (const terminalFrame of terminalFrames)",
];
let previousIndex = -1;
for (const marker of orderedMarkers) {
  const markerIndex = streamRegion.indexOf(marker);
  if (markerIndex <= previousIndex) {
    throw new Error(`Coze delivery order violated inside createBufferedCozeDeliveryStream: ${marker}`);
  }
  previousIndex = markerIndex;
}

if (!/errorCode === "LLM_BILLING_FAILED"\)\) return \{ state: "reconciliation_required", errorCode: "LLM_BILLING_FAILED" \}/u.test(idempotencySource)) {
  throw new Error("Missing Coze billing invariant: LLM_BILLING_FAILED must classify as reconciliation_required");
}

const postRegion = source.slice(source.indexOf("export async function POST"));
const billingGateIndex = postRegion.indexOf("const rawBillingSnapshot = await getSelectedModelBillingSnapshot");
const providerCallIndex = postRegion.indexOf("return streamChat(");
if (billingGateIndex < 0 || providerCallIndex <= billingGateIndex) {
  throw new Error("Model pricing gate must run before the Coze provider request");
}

console.log("Coze public-model billing gate: PASS");
