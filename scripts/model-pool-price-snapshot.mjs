#!/usr/bin/env node
/**
 * 生图模型价格快照与回滚（本地库）
 *
 * snapshot            记录当前所有启用模型的价格字段，写入带时间戳的快照和 latest.json
 * restore <file>      按快照 PATCH 回滚价格字段（只动 cost_price / selling_price / 价格表）
 * list                列出已有快照
 *
 * 只读写本地 runtime.json 指向的库；不触碰密钥输出。
 */
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const RUNTIME_FILE = "F:/总项目文件/Skill存储系统/运行数据/自媒体操盘手/local-data-20260902/config/runtime.json";
const SNAPSHOT_DIR = "F:/总项目文件/Skill存储系统/运行数据/自媒体操盘手/本地预览日志/model-pool-prices";

const runtime = JSON.parse(fs.readFileSync(RUNTIME_FILE, "utf8").replace(/^\uFEFF/u, ""));
const service = { apikey: runtime.serviceRoleKey, Authorization: `Bearer ${runtime.serviceRoleKey}` };
const SELECT = "id,name,model_name,provider,cost_price,selling_price,api_protocol_config";

function priceFields(row) {
  const config = row.api_protocol_config && typeof row.api_protocol_config === "object" ? row.api_protocol_config : {};
  return {
    cost_price: row.cost_price,
    selling_price: row.selling_price,
    resolution_cost_prices: config.resolution_cost_prices ?? config.resolutionCostPrices ?? null,
    resolution_prices: config.resolution_prices ?? config.resolutionPrices ?? null,
  };
}

async function loadRows() {
  const response = await fetch(`${runtime.supabaseUrl}/rest/v1/cover_models?select=${SELECT}&is_active=eq.true&order=name`, { headers: service });
  if (!response.ok) throw new Error(`读取失败 HTTP ${response.status}`);
  return response.json();
}

async function snapshot() {
  const rows = await loadRows();
  const payload = {
    schema: "model-pool-prices.v1",
    capturedAt: new Date().toISOString(),
    host: new URL(runtime.supabaseUrl).host,
    models: rows.map((row) => ({ id: row.id, name: row.name, model_name: row.model_name, provider: row.provider, ...priceFields(row) })),
  };
  fs.mkdirSync(SNAPSHOT_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const file = path.join(SNAPSHOT_DIR, `prices-${stamp}.json`);
  fs.writeFileSync(file, JSON.stringify(payload, null, 2));
  fs.writeFileSync(path.join(SNAPSHOT_DIR, "latest.json"), JSON.stringify(payload, null, 2));
  console.log(JSON.stringify({ file, models: payload.models.length }, null, 1));
}

async function restore(file) {
  const payload = JSON.parse(fs.readFileSync(file, "utf8"));
  if (payload.schema !== "model-pool-prices.v1") throw new Error("快照格式不匹配");
  const applied = [];
  for (const model of payload.models) {
    const current = await (await fetch(`${runtime.supabaseUrl}/rest/v1/cover_models?select=${SELECT}&id=eq.${encodeURIComponent(model.id)}`, { headers: service })).json();
    const row = current[0];
    if (!row) throw new Error(`模型不存在：${model.id}`);
    const config = { ...(row.api_protocol_config || {}) };
    if (model.resolution_cost_prices) config.resolution_cost_prices = model.resolution_cost_prices;
    if (model.resolution_prices) config.resolution_prices = model.resolution_prices;
    const response = await fetch(`${runtime.supabaseUrl}/rest/v1/cover_models?id=eq.${encodeURIComponent(model.id)}`, {
      method: "PATCH",
      headers: { ...service, "Content-Type": "application/json", Prefer: "return=representation" },
      body: JSON.stringify({ cost_price: model.cost_price, selling_price: model.selling_price, api_protocol_config: config, updated_at: new Date().toISOString() }),
    });
    if (!response.ok) throw new Error(`回滚失败 ${model.name}: ${await response.text()}`);
    applied.push(model.name);
  }
  console.log(JSON.stringify({ restored: applied.length, models: applied }, null, 1));
}

const [command, argument] = process.argv.slice(2);
if (command === "snapshot") await snapshot();
else if (command === "restore") {
  if (!argument) throw new Error("restore 需要快照文件路径");
  await restore(argument);
} else if (command === "list") {
  fs.mkdirSync(SNAPSHOT_DIR, { recursive: true });
  console.log(fs.readdirSync(SNAPSHOT_DIR).filter((name) => name.endsWith(".json")).sort().join("\n"));
} else {
  console.error("用法：snapshot | restore <file> | list");
  process.exit(2);
}
