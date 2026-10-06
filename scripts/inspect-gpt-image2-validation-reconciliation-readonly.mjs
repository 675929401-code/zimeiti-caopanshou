import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import pg from "pg";
import {
  LOCAL_PREVIEW_RUNTIME_FILE,
  validateLocalPreviewRuntime,
} from "./start-local-data-preview.mjs";

const MODEL_IDS = [
  "pending-cover-model-gpt-image-2-image-2-1k",
  "pending-cover-model-gpt-image-2-official",
  "pending-cover-model-gpt-image-2-adobe-mid",
];

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const objectValue = (value) => value && typeof value === "object" && !Array.isArray(value) ? value : {};
const responseSummary = (value) => {
  const response = objectValue(value);
  const providerResult = objectValue(response.providerResult);
  return {
    schema: typeof response.schema === "string" ? response.schema : null,
    keys: Object.keys(response).sort(),
    rejectionCode: typeof response.code === "string" ? response.code : null,
    rejectionSource: typeof response.source === "string" ? response.source : null,
    rejectionStatus: Number.isInteger(response.upstreamStatus) ? response.upstreamStatus : null,
    hasProviderCheckpoint: response.schema === "image_provider_checkpoint.v1",
    hasProviderResult: providerResult.schema === "image_provider_result.v1",
    providerResultKeys: Object.keys(providerResult).sort(),
    hasProviderUrl: typeof providerResult.rawUrl === "string" && providerResult.rawUrl.length > 0,
    selectedModelId: typeof response.selectedModelId === "string"
      ? response.selectedModelId
      : typeof providerResult.selectedModelId === "string"
        ? providerResult.selectedModelId
        : null,
  };
};

const runtime = JSON.parse(await fs.readFile(LOCAL_PREVIEW_RUNTIME_FILE, "utf8"));
validateLocalPreviewRuntime(runtime);
const connection = runtime.ownerConnection;
if (connection.host !== "127.0.0.1" || connection.port !== 54322 || connection.database !== "zimeiti_local") {
  throw new Error("LOCAL_TARGET_REQUIRED");
}

const client = new pg.Client(connection);
const report = {
  inspectedAt: new Date().toISOString(),
  target: { host: connection.host, port: connection.port, database: connection.database },
  localOnly: true,
  databaseWrites: 0,
  providerRequests: 0,
  paidGenerationRequests: 0,
  models: [],
};

try {
  await client.connect();
  await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  await client.query("SET LOCAL statement_timeout = '10s'");

  for (const modelId of MODEL_IDS) {
    const validations = await client.query(`
      SELECT validation_id, model_id, epoch, user_id, client_idempotency_key,
        image_record_id, payload_fingerprint, state, rejection_code,
        rejection_http_status, asset_id, created_at, updated_at, published_at
      FROM public.image_model_validations
      WHERE model_id = $1
      ORDER BY epoch DESC, created_at DESC
    `, [modelId]);

    const attempts = [];
    for (const validation of validations.rows) {
      const requestResult = await client.query(`
        SELECT record_id, user_id, client_idempotency_key, client_trace_id,
          payload_fingerprint, state, response, delivery_state, delivery_asset_id,
          created_at, updated_at
        FROM public.image_generation_requests
        WHERE record_id = $1 AND user_id = $2
      `, [validation.image_record_id, validation.user_id]);
      const request = requestResult.rows[0] || null;
      const billingKey = `image:h3_${sha256(`${validation.user_id}:${validation.client_idempotency_key}`).slice(0, 48)}`;
      const ledgerResult = await client.query(`
        SELECT
          (SELECT count(*)::integer FROM public.wallet_operations WHERE user_id::text = $1 AND idempotency_key = $2) AS operations,
          (SELECT count(*)::integer FROM public.wallet_ledger_entries WHERE user_id::text = $1 AND idempotency_key = $2) AS entries,
          (SELECT count(*)::integer FROM public.cash_transactions WHERE user_id::text = $1 AND reference_id = $2) AS cash_transactions
      `, [validation.user_id, billingKey]);
      const assetResult = validation.asset_id || request?.delivery_asset_id
        ? await client.query(`
          SELECT count(*)::integer AS count,
            bool_and(user_id::text = $2) AS owner_matches,
            bool_and(file_size > 0) AS nonempty
          FROM public.user_files
          WHERE id::text = $1
        `, [String(validation.asset_id || request.delivery_asset_id), validation.user_id])
        : { rows: [{ count: 0, owner_matches: null, nonempty: null }] };
      const response = responseSummary(request?.response);
      const identityMatches = Boolean(request)
        && request.record_id === validation.image_record_id
        && request.user_id === validation.user_id
        && request.client_idempotency_key === validation.client_idempotency_key
        && request.client_trace_id === validation.client_idempotency_key
        && request.payload_fingerprint === validation.payload_fingerprint;
      attempts.push({
        epoch: validation.epoch,
        validationState: validation.state,
        validationId: validation.validation_id,
        imageRecordId: validation.image_record_id,
        identityMatches,
        requestRecorded: Boolean(request),
        requestState: request?.state || "not_recorded",
        deliveryState: request?.delivery_state || null,
        validationHasAsset: Boolean(validation.asset_id),
        requestHasAsset: Boolean(request?.delivery_asset_id),
        response,
        rejection: {
          validationCode: validation.rejection_code || null,
          validationStatus: validation.rejection_http_status || null,
        },
        billing: ledgerResult.rows[0],
        asset: assetResult.rows[0],
        createdAt: validation.created_at,
        updatedAt: validation.updated_at,
        publishedAt: validation.published_at,
      });
    }
    report.models.push({ modelId, attemptCount: attempts.length, attempts });
  }
  await client.query("ROLLBACK");
} catch (error) {
  await client.query("ROLLBACK").catch(() => {});
  const safeCode = /^[A-Z0-9_]{1,60}$/u.test(String(error?.code)) ? error.code : "REDACTED";
  throw new Error(`READONLY_RECONCILIATION_CHECK_FAILED:${safeCode}`);
} finally {
  await client.end();
}

const output = path.join(
  ".codex-evidence",
  "gpt-image2-three-groups-live",
  "validation-reconciliation-readonly.json",
);
await fs.mkdir(path.dirname(output), { recursive: true });
await fs.writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({
  inspectedAt: report.inspectedAt,
  models: report.models,
  databaseWrites: 0,
  providerRequests: 0,
  paidGenerationRequests: 0,
  output,
}, null, 2));
