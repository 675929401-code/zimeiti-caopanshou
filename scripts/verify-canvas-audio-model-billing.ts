import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = process.cwd();
const read = (relativePath: string) => readFileSync(resolve(root, relativePath), "utf8");

const shell = read("src/components/free-canvas-shell.tsx");
const canvas = read("src/components/manual-canvas.tsx");
const schema = read("src/lib/workflow-schema.ts");
const types = read("src/lib/studio-canvas-types.ts");

const checks: Array<[string, boolean]> = [
  ["loads published voices", shell.includes('/api/voice/list?limit=500&page=1')],
  ["loads voice pricing", shell.includes('/api/voice/pricing')],
  ["filters unpriced image models", shell.includes('model.selling_price > 0')],
  ["filters unavailable or unpriced video models", shell.includes('model.pricePerUse > 0 && model.capabilities?.available !== false')],
  ["posts generated audio to the shared voice route", canvas.includes('fetch("/api/voice/tts"')],
  ["uses stable idempotency header", canvas.includes('"Idempotency-Key": clientRequestId')],
  ["submits TTS text and voice", canvas.includes('{ text: prompt.trim(), voiceId: voice!.id, clientRequestId }')],
  ["submits Seed Audio prompt", canvas.includes('{ textPrompt: prompt.trim(), clientRequestId }')],
  ["requires terminal completion", canvas.includes('generated?.terminalStatus !== "completed"')],
  ["requires permanent persistence", canvas.includes('generated.persisted !== true')],
  ["requires owned asset metadata", canvas.includes('!generated.asset?.id') && canvas.includes('!generated.asset.storageKey')],
  ["stores wallet credits", canvas.includes('creditsCharged = Number(') && schema.includes('creditsCharged: z.number().nonnegative().optional()')],
  ["stores retail RMB and billing unit", canvas.includes('retailPriceRmb = Number(') && schema.includes('billingUnit: z.string().max(80).optional()')],
  ["refreshes shared wallet after success", canvas.includes('onBalanceRefresh();')],
  ["preserves upload mode", canvas.includes('audioMode: "upload" as const')],
  ["declares published voice contracts", types.includes('export interface CanvasVoiceOption') && types.includes('export interface CanvasVoicePricing')],
];

for (const [label, passed] of checks) {
  assert.equal(passed, true, label);
  process.stdout.write(`PASS ${label}\n`);
}

process.stdout.write(`Canvas audio/model billing verifier: ${checks.length}/${checks.length} PASS\n`);
