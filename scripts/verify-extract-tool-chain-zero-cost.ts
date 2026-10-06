import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { readableExtractionError, sanitizeExtractionErrorFields } from "../src/lib/extraction-provider-error";
import { extractionHistoryEntry, sanitizeOwnedExtractionResponse } from "../src/lib/extraction-history";

const root = process.cwd();
const read = (path: string) => readFile(resolve(root, path), "utf8");

async function verifyFrontendContracts() {
  const [page, attemptPolicy, attemptStatusHook, attemptStatusRoute] = await Promise.all([
    read("src/app/extract/page.tsx"),
    read("src/lib/extract-client-attempt.ts"),
    read("src/hooks/use-extraction-attempt-status.ts"),
    read("src/app/api/extract/status/route.ts"),
  ]);

  assert.match(page, /buildClientRequestFingerprint/);
  assert.match(page, /resolveBrowserClientAttempt/);
  assert.match(page, /"Idempotency-Key": attempt\.clientRequestId/);
  assert.match(page, /client_request_id: attempt\.clientRequestId/);
  assert.match(page, /clearAttemptAfterDefinitiveHttpFailure/);
  assert.match(page, /isDefinitiveExtractionFailure/);
  assert.match(attemptPolicy, /body\?\.billing_unknown === true/);
  assert.match(attemptPolicy, /body\?\.retry_safe === false/);
  assert.match(attemptPolicy, /body\?\.charged === true/);
  assert.match(attemptPolicy, /body\?\.provider_call_started === false/);
  assert.match(attemptPolicy, /body\?\.success === false && body\?\.upstream_completed === true && body\?\.charged === false/);
  assert.match(attemptPolicy, /status >= 400 && status < 500/);
  assert.match(attemptPolicy, /!\[408, 409, 425, 429\]\.includes\(status\)/);

  for (const route of ["/api/extract", "/api/extract/batch", "/api/extract/search"]) {
    assert.match(page, new RegExp(route.replaceAll("/", "\\/")), `frontend missing ${route}`);
  }

  assert.match(page, /const requestLimit = mode === "video" \? Math\.min\(maxCount, 10\) : Math\.min\(maxCount, 30\)/);
  assert.match(page, /const cappedLinks = linkList\.slice\(0, requestLimit\)/);
  assert.match(page, /kind: "video-batch-item"[\s\S]*?batch:[\s\S]*?itemAttemptScope/);
  assert.match(page, /mode === "video" \? \[10\] : \[10, 20, 30\]/);
  assert.doesNotMatch(page, /\[10, 20, 30, 50\]/);
  assert.match(page, /const url = limitedLinks\[i\]/);
  assert.match(page, /itemSucceeded = Boolean\(item/);
  assert.match(page, /corrected_content \|\| \(item as TextItem\)\.content/);
  assert.match(page, /result:\s*\{[\s\S]*?texts:\s*\[\{/);
  assert.match(page, /triggerExtractDownload/);
  assert.doesNotMatch(page, /fetch\(videoItem\.download_url\)/, "history downloads must use the same safe streaming proxy");
  assert.match(page, /通道已配置/u, "customer tools must describe configuration evidence without claiming live health");
  assert.match(page, /正在核对通道配置与价格/u);
  assert.match(page, /无法读取通道配置，提交已暂停/u);
  assert.match(page, /通道未就绪，提交已暂停/u);
  assert.match(page, /计费：/u, "customer tools must show the configured public price");
  assert.doesNotMatch(page, /管理员免收/u, "customer tools must not replace the public price with an administrator exemption");
  assert.doesNotMatch(page, /当前通道：/u, "customer tools must not expose the internal provider channel");
  assert.doesNotMatch(page, /模型\/工作流：/u, "customer tools must not expose the internal workflow binding");
  assert.match(page, /mode === "video" \? 210_000 : 30_000/);
  assert.match(page, /PendingExtractionRequestError/);
  assert.match(page, /正在后台处理原请求/u);
  assert.match(page, /result\.pending[\s\S]*?pendingAttempt\.refresh/u);
  assert.match(page, /attempt\.state === "succeeded"[\s\S]*?setResult\(next\)/u);
  assert.match(page, /if \(embedded\) toolboxHost\?\.onTabChange\?\.\("segment"\)/);
  assert.match(page, /else router\.push\("\/segmenter"\)/);
  assert.doesNotMatch(page, /router\.push\(embedded \? "\/tools\?tab=segment"/);
  assert.match(page, /clientRequestId:\s*item\.clientRequestId/);
  assert.match(attemptStatusHook, /client_request_id/);
  assert.match(attemptStatusHook, /value\.state === 'running'/);
  assert.match(attemptStatusHook, /clearBrowserClientAttemptsById\('extract:' \+ userId \+ ':' \+ mode, value\.clientRequestId\)/);
  assert.doesNotMatch(attemptStatusHook, /method:\s*['"]POST['"]/);
  assert.match(attemptStatusRoute, /\.eq\('user_id', user\.id\)/);
  assert.match(attemptStatusRoute, /\.eq\('client_request_id', clientRequestId\)/);
}

async function verifyBackendIdentityAndGovernance() {
  const [single, batch, search, coze, exactlyOnce] = await Promise.all([
    read("src/app/api/extract/route.ts"),
    read("src/app/api/extract/batch/route.ts"),
    read("src/app/api/extract/search/route.ts"),
    read("src/app/api/extract/coze/route.ts"),
    read("src/lib/extraction-exactly-once.ts"),
  ]);

  for (const [name, source] of Object.entries({ single, batch, search, coze })) {
    assert.match(source, /withExtractionExactlyOnce/, `${name} must use the shared exactly-once boundary`);
  }
  assert.match(exactlyOnce, /request\.headers\.get\("Idempotency-Key"\)/);
  assert.match(exactlyOnce, /body\.client_request_id/);
  assert.match(exactlyOnce, /CLIENT_REQUEST_ID_PATTERN\.test\(value\)/);

  assert.doesNotMatch(batch, /getCyanlisConfig/, "batch must not steal a key from an inactive or unrelated plugin");
  assert.match(batch, /configuredProvider === "cyanlis"/);
  assert.match(batch, /\.eq\("is_active", true\)/);
  assert.match(batch, /pricePerUse: requireConfiguredExtractionMoney/);
  assert.match(batch, /costPrice: requireConfiguredExtractionMoney/);
  assert.match(batch, /costPrice: extractionTotalPrice\(batchConfig\.costPrice, successCount\)/);
  assert.match(batch, /extract-batch:\$\{clientRequestId\}:charge/);

  assert.doesNotMatch(search, /getCyanlisConfig/, "search must use the active governed channel");
  assert.match(search, /resolveSearchChannel/);
  assert.match(search, /"extract_batch_third_party", "extract_text_third_party"/);
  assert.match(search, /\.eq\("is_active", true\)/);
  assert.match(search, /price_per_use, cost_price/);
  assert.match(search, /configuredExtractionMoney\(data\.price_per_use\)/);
  assert.match(search, /configuredExtractionMoney\(data\.cost_price\)/);
  assert.match(search, /costPrice: extractionTotalPrice\(searchChannel\.costPrice, successCount\)/);
  assert.match(search, /extract-search:\$\{clientRequestId\}:charge/);
}

async function verifyDownloadProxy() {
  const [source, extractRoute, batchRoute, signature, localVideoRoute, localVideoCache, byteRange] = await Promise.all([
    read("src/app/api/extract/download/route.ts"),
    read("src/app/api/extract/route.ts"),
    read("src/app/api/extract/batch/route.ts"),
    read("src/lib/extract-download-signature.ts"),
    read("src/app/api/extract/local-video/route.ts"),
    read("src/lib/extract-local-video-cache.ts"),
    read("src/lib/http-byte-range.ts"),
  ]);
  assert.match(source, /getTokenFromHeaders/);
  assert.match(source, /verifyToken/);
  assert.match(source, /verifyExtractDownloadSignature/);
  assert.match(source, /safeFetchStream/);
  assert.match(await read("src/lib/safe-fetch.ts"), /redirect: "manual"/);
  assert.match(source, /validateDownloadUrl\(new URL\(location, current\)\)/);
  assert.match(source, /if \(rangeHeader\) headers\.Range = rangeHeader/);
  assert.equal((source.match(/\bsafeFetchStream\(/g) || []).length, 1, "range playback must not download the same upstream media twice");
  assert.doesNotMatch(source, /\bfetch\(/, "download proxy must not bypass the validated stream transport");
  assert.doesNotMatch(source, /redirect: "follow"/);
  assert.match(extractRoute, /createSignedExtractDownloadParams/);
  assert.match(signature, /createHmac\("sha256"/);
  assert.match(signature, /timingSafeEqual/);
  assert.match(signature, /MAX_SIGNED_URL_LIFETIME_MS/);
  assert.match(signature, /createSignedExtractLocalVideoParams/);
  assert.match(signature, /verifyExtractLocalVideoSignature/);

  for (const route of [extractRoute, batchRoute]) {
    assert.match(route, /cacheExtractVideoForProvider/);
    assert.doesNotMatch(route, /createHash\(['"]md5['"]\)\.update\(videoUrl\)/);
  }
  assert.match(localVideoCache, /safeFetch\(parsed/);
  assert.match(localVideoCache, /maxBytes: MAX_VIDEO_BYTES/);
  assert.match(localVideoCache, /allowedContentTypes: \["video\/\*"/);
  assert.match(localVideoCache, /createHmac\("sha256"/);
  assert.match(localVideoCache, /COZE_PROJECT_DOMAIN_DEFAULT is required/);
  assert.match(localVideoCache, /randomUUID\(\)/);
  assert.match(localVideoCache, /rename\(temporaryPath, filePath\)/);
  assert.match(localVideoCache, /cleanupExpiredCache/);
  const providerCache = localVideoCache.slice(localVideoCache.indexOf("export async function cacheExtractVideoForProvider"), localVideoCache.indexOf("export async function cacheExtractVideoForTemporaryOwner"));
  const temporaryOwnerCache = localVideoCache.slice(localVideoCache.indexOf("export async function cacheExtractVideoForTemporaryOwner"));
  assert.doesNotMatch(providerCache, /systemDnsPinned:\s*true/);
  assert.match(temporaryOwnerCache, /systemDnsPinned:\s*true/);
  assert.match(await read("src/lib/safe-fetch.ts"), /networkPolicy === "system-dns-pinned"/);
  assert.match(localVideoRoute, /verifyExtractLocalVideoSignature/);
  const localVideoHandler = localVideoRoute.slice(localVideoRoute.indexOf("export async function GET"));
  assert.ok(
    localVideoHandler.indexOf("verifyExtractLocalVideoSignature") < localVideoHandler.indexOf("resolveExtractLocalVideoPath"),
    "signed pickup authorization must precede local file resolution",
  );
  assert.match(localVideoRoute, /parseSingleByteRange\(request\.headers\.get\("range"\), fileStat\.size\)/);
  assert.match(localVideoRoute, /Readable\.toWeb\(createReadStream\(filePath, range \|\| undefined\)\)/);
  assert.match(localVideoRoute, /status: range \? 206 : 200/);
  assert.match(localVideoRoute, /"Accept-Ranges": "bytes"/);
  assert.match(localVideoRoute, /"Content-Range": `bytes \$\{range\.start\}-\$\{range\.end\}\/\$\{fileStat\.size\}`/);
  assert.match(localVideoRoute, /status: 416/);
  assert.match(byteRange, /value\.includes\(","\)/);
  assert.match(byteRange, /Math\.max\(0, size - suffixLength\)/);
  assert.match(byteRange, /start >= size/);
  assert.match(localVideoRoute, /Cache-Control": "private, no-store"/);
  assert.match(localVideoRoute, /X-Content-Type-Options": "nosniff"/);
  assert.doesNotMatch(localVideoRoute, /readFile\(/, "provider pickup must stream instead of buffering the whole video in memory");
  assert.doesNotMatch(localVideoRoute, /Access-Control-Allow-Origin/, "signed server-to-server pickup does not need a public CORS wildcard");
}

async function verifyExtractionExactlyOnce() {
  const [contract, migration, single, batch, search, coze, recoveryScript] = await Promise.all([
    read("src/lib/extraction-exactly-once.ts"),
    read("supabase/migrations/20260901093000_extraction_attempts_exactly_once.sql"),
    read("src/app/api/extract/route.ts"),
    read("src/app/api/extract/batch/route.ts"),
    read("src/app/api/extract/search/route.ts"),
    read("src/app/api/extract/coze/route.ts"),
    read("scripts/recover-extraction-checkpoint-once.mjs"),
  ]);

  assert.match(migration, /CREATE TABLE IF NOT EXISTS public\.extraction_attempts/);
  assert.match(migration, /UNIQUE \(user_id, client_request_id\)/);
  assert.match(migration, /state IN \('running', 'succeeded', 'failed', 'failed_unknown'\)/);
  assert.match(migration, /CREATE OR REPLACE FUNCTION public\.claim_extraction_attempt_atomic/);
  assert.match(migration, /pg_advisory_xact_lock/);
  assert.match(migration, /CREATE OR REPLACE FUNCTION public\.finalize_extraction_attempt_atomic/);
  assert.match(migration, /ENABLE ROW LEVEL SECURITY/);
  assert.match(migration, /REVOKE ALL ON TABLE public\.extraction_attempts FROM PUBLIC, anon, authenticated/);
  assert.match(migration, /provider_task_id/);
  assert.match(migration, /provider_evidence/);
  assert.match(migration, /billing_evidence/);

  assert.match(contract, /DatabaseExtractionAttemptStore/);
  assert.match(contract, /claim_extraction_attempt_atomic/);
  assert.match(contract, /finalize_extraction_attempt_atomic/);
  assert.match(contract, /EXTRACTION_ATTEMPT_MIGRATION_NOT_READY/);
  assert.match(contract, /EXTRACTION_ATTEMPT_RUNNING/);
  assert.match(contract, /EXTRACTION_ATTEMPT_FAILED_UNKNOWN/);
  assert.match(contract, /X-Extraction-Replayed/);
  assert.match(contract, /providerTaskId/);
  assert.match(contract, /billingEvidence/);
  assert.match(contract, /EXTRACTION_CLIENT_REQUEST_ID_REQUIRED/);
  assert.match(contract, /finalizeWithRetry/);
  assert.match(contract, /X-Extraction-Attempt-Id/);
  assert.doesNotMatch(contract, /MemoryExtraction|FileExtraction|localStorage/, "production extraction idempotency must be database-backed only");
  const providerHandlerExecution = contract.indexOf("response = await extractionExecution.run({ store, record: claimed.record }, () => handler(request))");
  const terminalFinalize = contract.lastIndexOf("const saved = await finalizeWithRetry");
  const terminalDelivery = contract.lastIndexOf("return withCheckpointOnlyProof(responseForClient)");
  assert.ok(
    contract.indexOf("store.claim(") < providerHandlerExecution,
    "provider handler must run only after the durable claim",
  );
  assert.ok(
    providerHandlerExecution < terminalFinalize && terminalFinalize < terminalDelivery,
    "response must be durably finalized before delivery",
  );
  assert.match(contract, /checkpointOnly && claimed\.created/);
  assert.match(contract, /X-Extraction-Provider-Handler", "skipped"/);
  assert.match(contract, /provider_handler_reached: false/);
  assert.match(recoveryScript, /"X-Extraction-Recovery-Mode": "checkpoint-only"/);
  assert.match(recoveryScript, /CHECKPOINT_ONLY_RESPONSE_PROOF_MISSING/);
  assert.match(recoveryScript, /PROVIDER_HANDLER_SKIP_PROOF_MISSING/);
  assert.match(recoveryScript, /verifyLocalBuildFingerprintReceipt/);

  for (const [name, source, kind] of [
    ["single", single, "single"],
    ["batch", batch, "batch"],
    ["search", search, "search"],
    ["coze", coze, "coze"],
  ] as const) {
    assert.match(source, /withExtractionExactlyOnce/, `${name} must import the durable wrapper`);
    assert.match(source, new RegExp(`withExtractionExactlyOnce\\(\\s*["']${kind}["']`));
  }
}

async function verifyLocalOnlyTools() {
  const [formatter, formatterHistory, segmenter, segmenterHistory, segmenterHistoryDetail, handoff, semanticApi] = await Promise.all([
    read("src/app/formatter/page.tsx"),
    read("src/app/api/formatter/history/route.ts"),
    read("src/app/segmenter/page.tsx"),
    read("src/app/api/segmenter/history/route.ts"),
    read("src/app/api/segmenter/history/detail/route.ts"),
    read("src/lib/extract-segment-handoff.ts"),
    read("src/app/api/segmenter/semantic/route.ts"),
  ]);
  assert.match(formatter, /formatText/);
  assert.match(formatter, /\/api\/formatter\/history/);
  assert.match(formatter, /固定排版规则：/u);
  assert.match(formatter, /本地处理，免费使用/u);
  assert.doesNotMatch(formatter, /当前通道|固定排版规则引擎|模型：|单价：/u, "customer formatter must not expose internal runtime terminology");
  assert.doesNotMatch(formatter, /\/api\/(?:llm|chat|extract|image|video|voice)/, "formatter may persist history but must not invoke a paid model");
  assert.doesNotMatch(formatter, /usePersistedState/, "formatter editor drafts must not survive refresh or later visits");
  assert.match(formatter, /app_state_formatter_input/);
  assert.match(formatter, /sessionStorage\.removeItem\(key\)/);
  assert.match(segmenter, /segmentTextRule/);
  assert.doesNotMatch(segmenter, /\/api\/segmenter\/semantic/, "rule-only segmenter must not invoke a model endpoint");
  assert.doesNotMatch(segmenter, /useToolRuntimeCatalog|buildClientRequestFingerprint|resolveBrowserClientAttempt/);
  assert.doesNotMatch(segmenter, /当前通道|管理员免收|Token|语义模型/u, "customer segmenter must not expose model or administrator internals");
  assert.match(segmenter, /分段规则：按所选时长对应的字数范围/u);
  assert.match(segmenter, /embedded && toolboxHost\?\.activeTab !== "segment"/u,
    "hidden embedded segmenter must ignore the global submit shortcut");

  assert.match(semanticApi, /SEGMENTER_RULE_ONLY/);
  assert.match(semanticApi, /X-Segmenter-Provider-Call/);
  assert.match(semanticApi, /provider_call_started:\s*false/);
  assert.match(semanticApi, /charged:\s*false/);
  assert.match(semanticApi, /status:\s*410/);
  assert.doesNotMatch(semanticApi, /runBillableSemanticSegmentation|withExtractionExactlyOnce|getTokenFromHeaders|verifyToken/);
  assert.match(segmenterHistory, /SEMANTIC_FALLBACK_NOT_SUCCESS_HISTORY/);
  assert.doesNotMatch(segmenter, /usePersistedState/, "segmenter editor drafts must not survive refresh or later visits");
  assert.match(segmenter, /consumeExtractSegmentDraft/);
  assert.match(handoff, /SEGMENTER_HANDOFF_KEY/);
  assert.match(handoff, /storage\.removeItem\(key\)/);
  for (const [name, history] of Object.entries({ formatterHistory, segmenterHistory })) {
    const getHandler = history.slice(history.indexOf("export async function GET"), history.indexOf("export async function POST"));
    assert.doesNotMatch(getHandler, /\.delete\(\)/, `${name} GET must not mutate history`);
    assert.doesNotMatch(getHandler, /HISTORY_RETENTION|created_at.*cutoff|\.gte\("created_at"/, `${name} GET must not hide older saved history`);
    assert.match(getHandler, /\.order\("created_at", \{ ascending: false \}\)/, `${name} history must be newest first`);
    assert.match(getHandler, /\.limit\(100\)/, `${name} history response must stay bounded`);
  }
  assert.doesNotMatch(segmenterHistoryDetail, /HISTORY_RETENTION|created_at.*cutoff|\.gte\("created_at"/, "visible segmenter history must remain restorable");
  assert.match(segmenterHistoryDetail, /\.eq\("user_id", auth\.userId as string\)/, "segmenter history detail must remain owner-scoped");
}

async function verifyErrorSanitization() {
  const secret = "sk-fixture-secret";
  const raw = {
    success: false,
    error: "invalid token " + secret,
    results: [{ success: false, error: "credential=" + secret }],
    captions: [{ error: "authorization bearer " + secret }],
  };
  const sanitized = sanitizeExtractionErrorFields(raw);
  const owned = sanitizeOwnedExtractionResponse(raw);
  assert.doesNotMatch(JSON.stringify(sanitized), /sk-fixture-secret/u);
  assert.doesNotMatch(JSON.stringify(owned), /sk-fixture-secret/u);
  assert.doesNotMatch(readableExtractionError("invalid token " + secret), /sk-fixture-secret/u);

  const history = extractionHistoryEntry({
    record_id: "fixture-record",
    client_request_id: "extract-text-fixture-12345678",
    request_kind: "single",
    state: "failed",
    response: raw,
    error_message: "invalid token " + secret,
    billing_evidence: { charged: false },
    request_snapshot: {},
    created_at: new Date(0).toISOString(),
  });
  assert.doesNotMatch(JSON.stringify(history), /sk-fixture-secret/u,
    "history replay must never reveal provider credentials");

  const [exactlyOnce, cozeHandler, route] = await Promise.all([
    read("src/lib/extraction-exactly-once.ts"),
    read("src/lib/coze-extraction-handler.ts"),
    read("src/app/api/extract/route.ts"),
  ]);
  assert.match(exactlyOnce, /bodyEvidence = sanitizeOwnedExtractionResponse\(await readJsonResponse\(response\)\)/);
  assert.match(exactlyOnce, /p_provider_result:[\s\S]*?sanitizeExtractionErrorFields\(input\.providerResult\)/);
  assert.match(exactlyOnce, /p_error_message: input\.errorMessage \? sanitizedErrorMessage\(input\.errorMessage\) : null/);
  assert.doesNotMatch(cozeHandler, /console\.error\("\[CozeExtract API\] Error:", error\)/);
  assert.match(route, /delete deliveredVideo\.cover/);
}

async function main() {
  await verifyFrontendContracts();
  await verifyBackendIdentityAndGovernance();
  await verifyDownloadProxy();
  await verifyExtractionExactlyOnce();
  await verifyLocalOnlyTools();
  await verifyErrorSanitization();
  console.log("[extract-tool-chain-zero-cost] UI/API identity, active-plugin pricing, database exactly-once replay, provider/billing evidence, single-fetch media proxy, local formatter, and rule-only segmenter contracts passed. No provider call was made.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
