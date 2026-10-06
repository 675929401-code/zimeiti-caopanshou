import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { isPublishedTextModelEligible, isTextModelEligible } from "../src/lib/text-model-eligibility";

function source(relativePath: string): string {
  return readFileSync(relativePath, "utf8");
}

assert.equal(isTextModelEligible({
  name: "GLM-Image 官方直连",
  model_name: "glm-image",
  category: "text",
}), false, "image-generation identifiers must not enter text selectors");
assert.equal(isTextModelEligible({
  name: "Seedream 图片生成",
  model_name: "seedream-4.0",
  category: "image",
}), false, "explicit image categories must not enter text selectors");
assert.equal(isTextModelEligible({
  name: "GPT-4o 多模态对话",
  model_name: "gpt-4o",
  category: "chat",
  description: "支持文本和图片理解的对话模型",
}), true, "multimodal chat models must remain selectable");
assert.equal(isTextModelEligible({
  name: "Suno V4",
  model_name: "suno-v4",
  category: "text",
}), false, "audio/video generation identifiers must not enter text selectors even with a legacy text category");
assert.equal(isPublishedTextModelEligible({
  id: "pending-chat-model",
  name: "Pending Chat",
  model_name: "pending-chat",
  category: "chat",
  is_active: true,
  is_hidden: false,
  user_access: "pending_model_activation",
}), false, "pending text models must stay out of every user-facing selector");

for (const route of ["src/app/api/chat-models/route.ts", "src/app/api/llm-models/route.ts"]) {
  assert.match(source(route), /filter\(isPublishedTextModelEligible\)/u, `${route} must apply the shared publication gate`);
}

const previewRoute = source("src/app/api/voice/preview/route.ts");
const previewProvider = source("src/lib/server/voice-preview-synthesis.ts");
assert.match(previewRoute, /withAuth\(req,/u, "voice preview must require an active database-backed session");
assert.match(previewRoute, /PREVIEW_USER_LIMIT/u, "voice preview must enforce a per-user limit");
assert.match(previewRoute, /PREVIEW_IP_LIMIT/u, "voice preview must enforce a per-IP limit");
assert.match(previewProvider, /loadVolcanoVoiceProviderConfig/u, "voice preview must use the unified provider binding");
assert.match(previewProvider, /safeFetch/u, "provider audio downloads must use the bounded SSRF-safe fetcher");
assert.doesNotMatch(previewRoute + previewProvider, /getAllEngineConfigs|getActiveApiKey|queryOne/u, "voice preview must not read legacy plaintext stores");
assert.doesNotMatch(previewRoute, /inputText|body\?\.text|body\.text/u, "clients must not synthesize arbitrary text through preview");
assert.doesNotMatch(previewRoute + previewProvider, /process\.env\.(?:VOLCENGINE_API_KEY_1|VOLC_TOKEN)/u, "voice preview must not fall back to plaintext environment keys");

const previewClient = source("src/lib/vs/preview-cache.ts");
assert.match(previewClient, /Authorization:\s*`Bearer \$\{token\}`/u, "voice preview client must send the authenticated session");
assert.doesNotMatch(previewClient, /JSON\.stringify\(\{\s*text:/u, "voice preview client must not send arbitrary synthesis text");

const extractRoute = source("src/app/api/extract/route.ts");
assert.match(extractRoute, /providerLogHost/u, "extract provider logs must use a host-only formatter");
assert.doesNotMatch(extractRoute, /console\.(?:log|error)\([^\n]*(?:ppt6Url|clientSecretKey|clientId=)/u, "PPT6 credentials must never enter logs");
assert.doesNotMatch(extractRoute, /console\.log\([^\n]*JSON\.stringify\(ppt6Result\)/u, "raw PPT6 responses must not enter logs");

const ffmpegResolver = source("src/lib/video-postprocess.ts");
const standaloneAssets = source("scripts/prepare-next-standalone-assets.mjs");
assert.match(ffmpegResolver, /runtime-tools/u, "runtime FFmpeg resolver must check the standalone tool directory");
assert.match(ffmpegResolver, /process\.env\.NODE_ENV === "production"/u, "runtime FFmpeg resolver must use the deterministic production tool directory");
assert.doesNotMatch(ffmpegResolver, /readdirSync|statSync|resolvePnpmFfmpeg/u, "runtime FFmpeg resolution must not dynamically scan the checkout");
assert.match(standaloneAssets, /materializeWebFfmpeg/u, "standalone preparation must materialize the platform FFmpeg binary");
assert.match(standaloneAssets, /runtimeTools/u, "standalone receipt must inventory runtime tools");

console.log("PASS provider/model/voice/extract/FFmpeg security and runtime contracts");
