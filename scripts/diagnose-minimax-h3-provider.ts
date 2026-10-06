import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { buildOpenAIEndpoint } from "../src/lib/api-endpoints";
import { getSupabaseAdminClient } from "../src/storage/database/supabase-client";

const reviewPath = process.env.REVIEW_PATH
  || "public/storyboard-reviews/dog-behaviors-three-directors-v62-live-20260814.json";
const outputPath = ".tmp-e2e/minimax-h3-provider-diagnostic-20260814.json";

async function main() {
  const db = getSupabaseAdminClient();
  const { data: model, error } = await db
    .from("video_models")
    .select("id,name,model_name,provider,protocol_type,api_endpoint,api_key,is_active,is_hidden,cost_price,price_per_use,total_requests,success_count,fail_count,last_success_at")
    .eq("id", "minimax-h3-chA")
    .single();
  assert.ok(!error && model, error?.message || "MiniMax H3 配置不存在");
  assert.ok(model.api_key, "MiniMax H3 未配置密钥");

  const review = JSON.parse(await readFile(reviewPath, "utf8")) as {
    run?: { cards?: Array<{ imageUrl?: string }> };
  };
  const imageUrl = review.run?.cards?.[0]?.imageUrl || "";
  assert.match(imageUrl, /^https:\/\//i, "诊断参考图不是公网HTTPS地址");

  const [modelsResponse, imageResponse] = await Promise.all([
    fetch(buildOpenAIEndpoint(model.api_endpoint, "models"), {
      headers: { Authorization: `Bearer ${model.api_key}` },
      signal: AbortSignal.timeout(30_000),
    }),
    fetch(imageUrl, { method: "GET", signal: AbortSignal.timeout(30_000) }),
  ]);
  const modelsPayload = await modelsResponse.json().catch(() => ({})) as {
    data?: Array<{ id?: string; name?: string }>;
    models?: Array<{ id?: string; name?: string }>;
    error?: unknown;
  };
  const models = Array.isArray(modelsPayload.data)
    ? modelsPayload.data
    : Array.isArray(modelsPayload.models)
      ? modelsPayload.models
      : [];
  const minimaxMatches = models
    .map((item) => String(item.id || item.name || ""))
    .filter((id) => /minimax.*h3|h3.*minimax/i.test(id));

  const diagnostic = {
    testedAt: new Date().toISOString(),
    config: {
      id: model.id,
      modelName: model.model_name,
      provider: model.provider,
      protocolType: model.protocol_type,
      apiEndpoint: model.api_endpoint,
      apiKeyPresent: Boolean(model.api_key),
      isActive: model.is_active,
      isHidden: model.is_hidden,
      costPrice: model.cost_price,
      pricePerUse: model.price_per_use,
      totalRequests: model.total_requests,
      successCount: model.success_count,
      failCount: model.fail_count,
      lastSuccessAt: model.last_success_at,
    },
    upstreamModels: {
      status: modelsResponse.status,
      responseOk: modelsResponse.ok,
      returnedCount: models.length,
      minimaxMatches,
      errorPresent: Boolean(modelsPayload.error),
    },
    referenceImage: {
      status: imageResponse.status,
      responseOk: imageResponse.ok,
      contentType: imageResponse.headers.get("content-type"),
      contentLength: imageResponse.headers.get("content-length"),
    },
  };
  await writeFile(outputPath, JSON.stringify(diagnostic, null, 2), "utf8");
  console.log(JSON.stringify({ ...diagnostic, outputPath }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
