import fs from "node:fs";
import path from "node:path";
import { resolveVideoCharge } from "@/lib/video-model-capabilities";

const root = process.cwd();
const read = (relative: string) => fs.readFileSync(path.join(root, relative), "utf8");
const generateRoute = read("src/app/api/video/generate/route.ts");
const modelsRoute = read("src/app/api/video/models/route.ts");
const workspaceModelsRoute = read("src/app/api/admin/workspace-models/route.ts");
const finalizer = read("src/lib/video-terminal-finalizer.ts");
const longHistoryRoute = read("src/app/api/digital-human/long-history/route.ts");
const longStatusRoute = read("src/app/api/digital-human/long-status/route.ts");
const mediaWorkerRuntime = read("src/lib/media-queue-worker-runtime.ts");
const storyboardAgentRoute = read("src/app/api/storyboard/agent/route.ts");
const digitalHumanLongCreate = read("src/lib/digital-human-long-create.ts");
const voiceDb = read("src/lib/voice-studio/db.ts");
const voiceCatalog = read("src/lib/voice-studio/catalog.ts");
const voicePricing = read("src/lib/vs/pricing.ts");

const configured = resolveVideoCharge({
  price_per_use: 1.2,
  cost_price: 0.8,
}, "1080p", 5);
const missingCost = resolveVideoCharge({ price_per_use: 1.2 }, "1080p", 5);
const nullCost = resolveVideoCharge({ price_per_use: 1.2, cost_price: null }, "1080p", 5);
const missingPrice = resolveVideoCharge({ cost_price: 0.8 }, "1080p", 5);

const assetBridge = generateRoute.indexOf("bridgeVideoProviderAsset(", generateRoute.indexOf("export async function POST"));
const reservation = generateRoute.indexOf("reserveVideoGenerationTask({");

const checks: Array<[string, boolean]> = [
  ["submission does not add a second acceptance-evidence gate", !generateRoute.includes("inspectVideoModelActivationReadiness({") && !generateRoute.includes('error_code: "MODEL_ACCEPTANCE_EVIDENCE_INCOMPLETE"')],
  ["input and protocol validation still precede provider bridging", generateRoute.indexOf("validateVideoInputContract(") < assetBridge],
  ["price reservation and provider bridging remain present", reservation > 0 && assetBridge > 0],
  ["public catalog reads supplier cost", modelsRoute.includes("price_per_use, cost_price, duration_seconds")],
  ["public catalog requires a complete price snapshot", modelsRoute.includes("requireVideoPriceSnapshot(m, resolutionTier, durationCapabilities.defaultDuration)")],
  ["public catalog does not evaluate internal acceptance evidence", !modelsRoute.includes("inspectVideoModelActivationReadiness({")],
  ["public generation readiness follows live availability", modelsRoute.includes("const generationReady = available") && modelsRoute.includes("generationReady: model.generationReady")],
  ["public catalog does not expose internal acceptance copy", !modelsRoute.includes("activationReady: model.activationReady") && !modelsRoute.includes("readinessMessage: model.readinessMessage") && !modelsRoute.includes("真实生成尚未验收")],
  ["admin publishability follows active configured price-ready compatibility", workspaceModelsRoute.includes("const publishable = compatibility.compatible && active && !hidden && configured && priceReady;")],
  ["missing cost remains unknown", Number.isNaN(missingCost.costPrice)],
  ["null cost remains unknown", Number.isNaN(nullCost.costPrice)],
  ["missing sale price remains unknown", Number.isNaN(missingPrice.publicPrice)],
  ["configured paid quote is preserved", configured.publicPrice === 1.2 && configured.costPrice === 0.8],
  ["unknown sale price fails closed", finalizer.includes('"VIDEO_PRICE_CONFIGURATION_INVALID"') && finalizer.includes("!Number.isFinite(priceYuan)")],
  ["unknown supplier cost fails closed", finalizer.includes('"VIDEO_COST_CONFIGURATION_INVALID"') && finalizer.includes("!Number.isFinite(costPriceYuan)")],
  ["free mode requires an explicit marker", finalizer.includes("protocol.explicitly_free === true") && finalizer.includes('toLowerCase() === "free"')],
  ["long history GET does not start a worker", !longHistoryRoute.includes("startDigitalHumanLongWorker")],
  ["long status GET does not start a worker", !longStatusRoute.includes("startDigitalHumanLongWorker")],
  ["dedicated media process starts the long worker", mediaWorkerRuntime.includes("const long = startDigitalHumanLongWorker()")],
  ["storyboard agent prompt GET requires admin", /export async function GET\(request: Request\)[\s\S]*requireAdmin\(request\)/u.test(storyboardAgentRoute)],
  ["long digital-human submit enforces activation readiness", digitalHumanLongCreate.includes("inspectVideoModelActivationReadiness") && digitalHumanLongCreate.includes("MODEL_ACCEPTANCE_EVIDENCE_INCOMPLETE")],
  ["long digital-human submit rejects unknown cost", digitalHumanLongCreate.includes("!Number.isFinite(unitCharge.costPrice)") && digitalHumanLongCreate.includes("DIGITAL_HUMAN_LONG_COST_INVALID")],
  ["voice catalog uses a read-only SQLite connection", voiceCatalog.includes("getVoiceReadonlyDb") && voiceDb.includes("readonly: true")],
  ["voice pricing opens SQLite read-only", voicePricing.includes("readonly: true") && !voicePricing.includes("journal_mode = WAL")],
];

for (const [name, ok] of checks) console.log(`${ok ? "PASS" : "FAIL"} ${name}`);
const failed = checks.filter(([, ok]) => !ok);
if (failed.length > 0) {
  console.error(`${failed.length}/${checks.length} checks failed`);
  process.exit(1);
}
console.log(`${checks.length}/${checks.length} checks passed`);
