#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";

const files = {
  unified: fs.readFileSync("src/app/api/admin/models/route.ts", "utf8"),
  video: fs.readFileSync("src/app/api/admin/video-models/route.ts", "utf8"),
  chat: fs.readFileSync("src/app/api/admin/chat-models/route.ts", "utf8"),
  llmTest: fs.readFileSync("src/app/api/admin/llm-test/route.ts", "utf8"),
  unifiedUi: fs.readFileSync("src/components/unified-models-tab.tsx", "utf8"),
  unifiedDialog: fs.readFileSync("src/components/unified-model-dialog.tsx", "utf8"),
  videoDialog: fs.readFileSync("src/components/video-model-dialog.tsx", "utf8"),
  chatUi: fs.readFileSync("src/components/chat-models-tab.tsx", "utf8"),
  agents: fs.readFileSync("src/app/api/admin/agents/route.ts", "utf8"),
  adminConfig: fs.readFileSync("src/app/api/admin/config/route.ts", "utf8"),
  services: fs.readFileSync("src/app/api/admin/services/route.ts", "utf8"),
  voiceServices: fs.readFileSync("src/app/api/admin/voice-services/route.ts", "utf8"),
  voiceConfig: fs.readFileSync("src/app/api/admin/voice-config/route.ts", "utf8"),
  settings: fs.readFileSync("src/app/api/settings/route.ts", "utf8"),
  adminSettings: fs.readFileSync("src/app/api/settings/admin/route.ts", "utf8"),
  secretSettings: fs.readFileSync("src/lib/server/platform-secret-settings.ts", "utf8"),
  adminUi: fs.readFileSync("src/app/admin/page.tsx", "utf8"),
  manjuRoute: fs.readFileSync("src/app/api/admin/manju-workbench/status/route.ts", "utf8"),
  manjuSummary: fs.readFileSync("src/lib/manju-workbench-status.ts", "utf8"),
  coverModels: fs.readFileSync("src/app/api/admin/cover-models/route.ts", "utf8"),
  coverModel: fs.readFileSync("src/app/api/admin/cover-models/[id]/route.ts", "utf8"),
  syncExport: fs.readFileSync("src/app/api/admin/sync/export/route.ts", "utf8"),
  syncImport: fs.readFileSync("src/app/api/admin/sync/import/route.ts", "utf8"),
  backupApi: fs.readFileSync("src/app/api/admin/backup/route.ts", "utf8"),
};

for (const [name, source] of Object.entries({ unified: files.unified, video: files.video, chat: files.chat })) {
  assert.match(source, /function publicModel</u, `${name} API must redact stored credentials`);
  assert.match(source, /api_key_configured: Boolean/u, `${name} API must expose only credential presence`);
  assert.match(source, /function replacementApiKey/u, `${name} API must distinguish a replacement from an empty edit`);
  assert.match(source, /MASKED_SECRET/u, `${name} API must preserve stored credentials for masked edits`);
}

assert.doesNotMatch(files.unified, /api_key:\s*m\.api_key\s*\|\|/u,
  "unified model GET must not copy a credential into its response DTO");
assert.match(files.video, /models:\s*\(data\s*\|\|\s*\[\]\)[\s\S]*?\.map\(publicModel\)/u);
assert.match(files.chat, /models:\s*\(models\s*\|\|\s*\[\]\)\.map\(publicModel\)/u);
assert.doesNotMatch(files.unifiedUi, /apiKey\.slice|m\.api_key\s*\|\|/u,
  "model cards must not render a credential prefix");
assert.doesNotMatch(files.unifiedDialog, /api_key:\s*\(model\.api_key/u,
  "edit dialogs must never hydrate stored credentials into browser state");
assert.doesNotMatch(files.videoDialog, /api_key:\s*\(model\.api_key/u,
  "video edit dialog must never hydrate stored credentials into browser state");
assert.doesNotMatch(files.chatUi, /api_key:\s*model\.api_key/u,
  "chat edit dialog must never hydrate stored credentials into browser state");
assert.match(files.llmTest, /body\.model_id[\s\S]*?select\("id,model_name,name,api_endpoint,proxy_url,api_key,[^"]+"\)[\s\S]*?resolveProviderSecret\(draft\.apiKey\)/u,
  "connection tests for existing models must resolve credentials server-side by model identity");
assert.match(files.llmTest, /llm_model_validation_evidence/u,
  "successful existing-model probes must persist server-side activation evidence");

assert.match(files.agents, /function publicAgent/u);
assert.match(files.agents, /coze_coding_api_token_configured:/u);
assert.match(files.agents, /agents:\s*\(data \|\| \[\]\)\.map\(\(agent:[^)]*\)\s*=>\s*publicAgent\(agent,\s*\{\s*includePrompt\s*\}\)\)/u);
assert.match(files.agents, /credential_source_agent_id/u,
  "agent duplication must inherit credentials on the server");
assert.doesNotMatch(files.adminUi, /coze_coding_api_token:\s*agent\.coze_coding_api_token/u,
  "agent credentials must never round-trip through the admin browser");

for (const [name, source] of Object.entries({
  adminConfig: files.adminConfig,
  services: files.services,
  voiceServices: files.voiceServices,
  voiceConfig: files.voiceConfig,
})) {
  assert.match(source, /function public(?:Config|Card)/u, `${name} must redact stored credentials`);
  assert.match(source, /apiKeyConfigured:\s*Boolean/u, `${name} must expose credential presence only`);
  assert.match(source, /function replacementApiKey/u, `${name} must preserve blank edits`);
  assert.match(source, /MASKED_SECRET/u, `${name} must preserve masked edits`);
}
assert.match(files.voiceConfig, /data:\s*\{\s*success:\s*result\.success,\s*message:\s*result\.message\s*\}/u,
  "voice connection test responses must use a safe allowlist");

for (const key of [
  "coze_api_token",
  "coze_coding_api_token",
  "cover_workflow_token",
  "thinking_model_api_key",
  "extract_api_token",
  "xunhu_secret",
  "epay_key",
  "email_smtp_pass",
]) {
  assert.match(files.secretSettings, new RegExp(`"${key}"`, "u"), `${key} must be classified as secret`);
}
assert.doesNotMatch(files.secretSettings, /["']restore_token["']/u,
  "retired browser restore token must not remain a writable platform secret");
assert.match(files.adminSettings, /redactPlatformSettings\(data \|\| \[\]\)/u);
assert.match(files.adminSettings, /isPlatformSecretSettingKey\(key\).*isBlankOrMaskedSecret\(value\)/su);
assert.match(files.settings, /isAdmin && isPlatformSecretSettingKey\(item\.setting_key\)/u);
assert.match(files.settings, /isPlatformSecretSettingKey\(key\).*isBlankOrMaskedSecret\(value\)/su);
assert.doesNotMatch(files.adminUi, /xunhu_secret:\s*data\.settings\?\.xunhu_secret/u);
assert.doesNotMatch(files.adminUi, /epay_key:\s*data\.settings\?\.epay_key/u);
assert.match(files.adminUi, /已配置；留空保留原密钥/u);

assert.match(files.coverModels, /models:\s*\(data \|\| \[\]\)[\s\S]*?\.map\(publicModel\)/u);
assert.match(files.coverModels, /success:\s*true,\s*staged:\s*true,\s*published:\s*false,\s*result/u);
assert.doesNotMatch(files.coverModels, /NextResponse\.json\(\{[^}]*api_key/u,
  "staged cover-model responses must not return the submitted credential");
assert.match(files.coverModel, /function replacementApiKey/u);
assert.match(files.coverModel, /delete updateFields\.api_key/u);
assert.match(files.coverModel, /success:\s*true,\s*staged:\s*true,\s*published:\s*false,\s*result/u);
assert.doesNotMatch(files.coverModel, /NextResponse\.json\(\{[^}]*api_key/u,
  "staged single cover-model responses must not return the stored credential");
assert.doesNotMatch(files.adminUi, /api_key:\s*model\.api_key/u,
  "cover model edit forms must never hydrate a stored API key");
assert.match(files.syncExport, /sanitizeExportRows/u);
assert.match(files.syncExport, /secret_fields_excluded:\s*true/u);
assert.match(files.syncExport, /delete safe\.coze_coding_api_token/u);
assert.match(files.syncExport, /delete safe\.api_key/u);
assert.match(files.syncImport, /code:\s*'SAFE_MERGE_ONLY'/u);
assert.match(files.syncImport, /code:\s*'SYNC_SECRET_FIELDS_FORBIDDEN'/u);
assert.match(files.syncImport, /isPlatformSecretSettingKey/u);
assert.match(files.syncImport, /Object\.prototype\.hasOwnProperty\.call\(row, fieldName\)/u);
assert.doesNotMatch(files.adminUi, /useState<"merge"\s*\|\s*"overwrite">|全量覆盖模式将清空/u,
  "admin sync UI must not offer a destructive credential-erasing import mode");
assert.doesNotMatch(files.backupApi, /export async function PUT/u);
assert.doesNotMatch(files.backupApi, /return new NextResponse\(content/u,
  "complete disaster-recovery snapshots must never be downloaded through the browser");

const manjuSafeStatus = /export interface ManjuSafeModelStatus\s*\{([\s\S]*?)\n\}/u.exec(files.manjuSummary)?.[1] || "";
assert.ok(manjuSafeStatus, "manju safe status DTO must exist");
assert.doesNotMatch(manjuSafeStatus, /api[_A-Z]?key|token|secret|credential/iu,
  "manju browser DTO must not contain credential fields");
assert.match(files.manjuRoute, /return NextResponse\.json\(\{[\s\S]*?families,/u);

console.log("PASS admin model list and write responses omit stored API keys");
console.log("PASS blank or masked edits preserve stored API keys; explicit replacements remain supported");
console.log("PASS model edit dialogs show configured state without receiving credential text");
console.log("PASS existing-model connection tests resolve credentials on the server");
console.log("PASS agents, voice services and engine configuration responses expose configured flags only");
console.log("PASS platform, payment, restore and SMTP secrets never round-trip through settings responses");
console.log("PASS manju model status reduces protected bindings to safe readiness summaries");
console.log("PASS cover-model CRUD, sync export and browser backup routes exclude protected credentials");
