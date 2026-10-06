import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = process.cwd();
const source = (relativePath) => readFileSync(resolve(root, relativePath), "utf8");
const subElevenPixelFont = /font-size:\s*(?:[1-9]|10)(?:\.[0-9]+)?px/u;
const subElevenPixelTailwind = /text-\[(?:[1-9]|10)(?:\.[0-9]+)?px\]/u;

const accountNotifications = source("src/components/account-notification-center.tsx");
assert.match(accountNotifications, /text-\[11px\][^\n]*\{unreadCount\} 条未读/u);
assert.doesNotMatch(accountNotifications, subElevenPixelTailwind);

const officialAlias = source("src/features/official-tool-aliases/official-tool-alias-page.module.css");
assert.match(officialAlias, /\.promptField small,\.uploadField small[^\n]*font-size:12px/u);
assert.match(officialAlias, /\.previewSteps span[^\n]*font-size:12px/u);
assert.match(officialAlias, /\.previewSteps b[^\n]*font-size:11px/u);
assert.doesNotMatch(officialAlias, subElevenPixelFont);

const officialAgentRoute = source("src/features/official-core-routes/official-agent-route.module.css");
assert.match(officialAgentRoute, /\.modelPolicy\s*\{[^}]*font-size:\s*12px/u);

const voiceStudio = source("src/app/voice-studio/voice-studio.css");
assert.match(voiceStudio, /\.vs-studio-brand-copy small[^\n]*font-size:\s*11px/u);
assert.doesNotMatch(voiceStudio, subElevenPixelFont);

const softWhiteLanding = source("src/components/landing/soft-white-landing.css");
assert.match(softWhiteLanding, /\.swh-loop-kicker small\s*\{[^}]*font-size:\s*11px/u);
assert.match(softWhiteLanding, /\.swh-example-step-head small\s*\{[^}]*font-size:\s*11px/u);
assert.match(softWhiteLanding, /\.swh-example-outcome\s*\{[^}]*font-size:\s*12px/u);
assert.doesNotMatch(softWhiteLanding, subElevenPixelFont);

const operatingHome = source("src/components/landing/operating-home-v2.css");
assert.match(operatingHome, /\.swh-card-index[^\n]*font-size:\s*11px/u);
assert.doesNotMatch(operatingHome, subElevenPixelFont);

const announcements = source("src/app/announcements/page.tsx");
assert.doesNotMatch(announcements, subElevenPixelTailwind);

const generalScript = source("src/features/general-script-official/general-script-official.module.css");
assert.match(generalScript, /\.selectField small\s*\{[^}]*font-size:\s*11px/u);
assert.match(generalScript, /\.textareaField small\s*\{[^}]*font-size:\s*11px/u);
assert.match(generalScript, /\.flowGrid article p\s*\{[^}]*font-size:\s*12px/u);
assert.match(generalScript, /\.longFormPanel article p\s*\{[^}]*font-size:\s*12px/u);
assert.doesNotMatch(generalScript, subElevenPixelFont);

const formalRoute = source("src/app/tools/text/formal-script/page.tsx");
assert.match(formalRoute, /redirect\("\/tools\/text\/general-script"\)/u);
const generalRoute = source("src/app/tools/text/general-script/page.tsx");
assert.match(generalRoute, /@\/features\/general-script-official\/general-script-official/u);

const officialModelTools = source("src/features/official-model-tools/official-model-tools.module.css");
assert.match(officialModelTools, /\.segmented small\s*\{[^}]*font-size:\s*12px/u);
assert.doesNotMatch(officialModelTools, subElevenPixelFont);

const uploadScript = source("src/features/upload-script/upload-script.module.css");
assert.match(uploadScript, /\.styleField>span small\{font-size:12px/u);

const excludedDramaRoute = source("src/app/tools/text/drama-script/page.tsx");
assert.match(excludedDramaRoute, /@\/features\/drama-script\/drama-script-workbench/u);
assert.doesNotMatch(excludedDramaRoute, /general-script-official/u);

console.log(JSON.stringify({
  verifier: "r726-frontend-readability-contract",
  passed: true,
  productFilesChecked: 10,
  excludedDramaRouteUntouchedBySharedGeneralScriptSource: true,
  browserWrites: 0,
  providerCalls: 0,
}, null, 2));
