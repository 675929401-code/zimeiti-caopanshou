import fs from "node:fs/promises";
import pg from "pg";

const runtimePath = "F:/总项目文件/Skill存储系统/运行数据/自媒体操盘手/local-data-20260902/config/runtime.json";
const ids = [
  "secure-skill-doubao-seedance-2-0-g37",
  "secure-skill-doubao-seedance-2-0-fast-g37",
  "secure-skill-doubao-seedance-2-5-g37",
];

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

async function main() {
  const runtime = JSON.parse((await fs.readFile(runtimePath, "utf8")).replace(/^\uFEFF/u, ""));
  const client = new pg.Client({
    ...runtime.ownerConnection,
    application_name: "codex-inspect-secure-skill-seedance-token-billing-readonly",
  });
  await client.connect();
  try {
    const result = await client.query(
      `SELECT id, name, model_name, provider, protocol_type, is_active, is_hidden,
              price_per_use, cost_per_use, cost_price, api_protocol_config
         FROM public.video_models
        WHERE id = ANY($1::text[])
        ORDER BY id`,
      [ids],
    );
    console.log(JSON.stringify({
      readOnly: true,
      checkedAt: new Date().toISOString(),
      models: result.rows.map((row) => {
        const config = record(row.api_protocol_config);
        return {
          id: row.id,
          name: row.name,
          modelName: row.model_name,
          provider: row.provider,
          protocolType: row.protocol_type,
          active: row.is_active === true,
          hidden: row.is_hidden === true,
          pricePerUse: Number(row.price_per_use ?? 0),
          costPerUse: Number(row.cost_per_use ?? 0),
          costPrice: Number(row.cost_price ?? 0),
          providerBillingUnit: config.provider_billing_unit ?? null,
          billingUnit: config.billing_unit ?? null,
          publicBillingPending: config.public_billing_pending === true,
          tokenBillingAdapterReady: config.token_billing_adapter_ready === true,
          usageTotalTokensPath: config.usage_total_tokens_path ?? null,
          usageCompletionTokensPath: config.usage_completion_tokens_path ?? null,
          tokenCostPricesPerMillion: record(config.token_cost_prices_per_million),
          tokenSalePricesPerMillion: record(config.token_sale_prices_per_million),
          durationOptions: Array.isArray(config.duration_options) ? config.duration_options : [],
          defaultResolution: config.default_resolution ?? null,
        };
      }),
    }, null, 2));
  } finally {
    await client.end();
  }
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
