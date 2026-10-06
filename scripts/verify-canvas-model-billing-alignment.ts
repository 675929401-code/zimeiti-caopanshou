import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const read = (relativePath: string) => readFileSync(resolve(process.cwd(), relativePath), "utf8");

const freeCanvasShell = read("src/components/free-canvas-shell.tsx");
const manualCanvas = read("src/components/manual-canvas.tsx");
const publicModelDto = read("src/lib/public-model-dto.ts");
const imageGenerateRoute = read("src/app/api/image/generate/route.ts");
const videoGenerateRoute = read("src/app/api/video/generate/route.ts");
const voiceListRoute = read("src/app/api/voice/list/route.ts");
const voiceCatalog = read("src/lib/voice-studio/catalog.ts");
const voicePricingRoute = read("src/app/api/voice/pricing/route.ts");
const voiceTtsRoute = read("src/app/api/voice/tts/route.ts");

const checks: Array<[string, boolean]> = [
  ["Canvas loads the published image catalog for the free-canvas surface", freeCanvasShell.includes('fetch("/api/cover-models?surface=free-canvas")')],
  ["Canvas loads the published video catalog for the free-canvas surface", freeCanvasShell.includes('fetch("/api/video/models?surface=free-canvas")')],
  ["Image public prices are mapped from publicPrice", freeCanvasShell.includes("record.publicPrice ?? record.selling_price")],
  ["Video public prices are mapped from publicPrice", freeCanvasShell.includes("record.publicPrice ?? record.pricePerUse")],
  ["Browser-facing models use a semantic public provider rather than an internal provider", freeCanvasShell.includes('provider: "platform_public"')],
  ["Image generation uses the selected public model id", manualCanvas.includes("modelId: model.id")],
  ["Video generation uses the selected public model id", manualCanvas.includes("model_id: model.id")],
  ["Image generation goes through the shared bridge endpoint", manualCanvas.includes('fetch("/api/bridge/image/generate"')],
  ["Video generation goes through the shared bridge endpoint", manualCanvas.includes('fetch("/api/bridge/video/generate"')],
  ["Video task polling preserves the selected model id", manualCanvas.includes("modelId: model.id") && manualCanvas.includes('fetch(`/api/bridge/video/status?')],
  ["Canvas records actual image cash charges", manualCanvas.includes("cashCharged") && manualCanvas.includes("cashRemaining")],
  ["Canvas records actual video charges", manualCanvas.includes("priceCharged")],
  ["Image model selectors show a per-image billing unit", (manualCanvas.match(/toFixed\(2\)\}\/张/g) || []).length >= 2],
  ["Video model selectors show the route-provided billing unit", manualCanvas.includes('billingUnit === "output_second"') && manualCanvas.includes(' : "/次"')],
  ["Public model DTO strips internal provider and model credentials", publicModelDto.includes('"provider", "channel", "protocol"') && publicModelDto.includes('"apikey", "api_key", "modelname", "model_name"')],
  ["Image API resolves an opaque public id server-side", imageGenerateRoute.includes("findModelByPublicId") && imageGenerateRoute.includes("executeCashDeduction")],
  ["Video API resolves an opaque public id and freezes its price server-side", videoGenerateRoute.includes("findModelByPublicId") && videoGenerateRoute.includes("requireVideoPriceSnapshot") && videoGenerateRoute.includes("checkCashBalance")],
  ["Audio and music retain honest local upload modes in Canvas", manualCanvas.includes('addNode("upload", "audio")') && manualCanvas.includes('addNode("upload", "music")')],
  ["Canvas loads the main-site voice catalog and pricing", freeCanvasShell.includes('fetch("/api/voice/list?limit=500&page=1")') && freeCanvasShell.includes('fetch("/api/voice/pricing")')],
  ["Canvas filters unpriced image models and unavailable video models", freeCanvasShell.includes("model.selling_price > 0") && freeCanvasShell.includes("model.pricePerUse > 0") && freeCanvasShell.includes("model.capabilities?.available !== false")],
  ["Canvas TTS and AI audio use the shared voice route", manualCanvas.includes('fetch("/api/voice/tts"') && manualCanvas.includes('audioMode === "tts"') && manualCanvas.includes('audioMode === "seed-audio"')],
  ["Canvas audio generation uses an idempotency key", manualCanvas.includes('"Idempotency-Key": clientRequestId')],
  ["Canvas does not pretend to call an unimplemented separate music generator", !manualCanvas.includes("/api/music/generate")],
  ["Main-site voice catalog remains the source for published voices", voiceListRoute.includes("readVoiceCatalog") && voiceCatalog.includes("OFFICIAL_VOICES")],
  ["Main-site voice pricing derives from the pricing source of truth", voicePricingRoute.includes("getAllModelPricing")],
  ["Main-site TTS route uses the atomic shared credit lifecycle", voiceTtsRoute.includes("beginVoiceGenerationAtomic") && voiceTtsRoute.includes("finalizeVoiceGenerationAtomic") && voiceTtsRoute.includes("refundVoiceGenerationAtomic")],
];

const failed = checks.filter(([, passed]) => !passed);
for (const [name, passed] of checks) {
  console.log(`${passed ? "PASS" : "FAIL"} ${name}`);
}

if (failed.length > 0) {
  console.error(`\n${failed.length}/${checks.length} Canvas model/billing contract checks failed.`);
  process.exitCode = 1;
} else {
  console.log(`\n${checks.length}/${checks.length} Canvas model/billing contract checks passed.`);
}
