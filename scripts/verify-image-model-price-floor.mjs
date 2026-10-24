#!/usr/bin/env node
/**
 * 生图模型价格底线守卫（只读、离线比对本地库）
 *
 * 规则：
 * 1) 每个档位的成本价不得低于已核实的供应商单价（camelCase/snake 两种写法都读）；
 * 2) 每个档位的售价不得低于同档成本（保本价允许相等，不允许亏本）；
 * 3) 未登记供应商价的模型只校验规则 2，并在报告里标为 unverified，不谎报已验证。
 *
 * 用法：node scripts/verify-image-model-price-floor.mjs
 * 退出码：0 = 无违规；1 = 存在违规或读取失败。
 */
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const RUNTIME_FILE = "F:/总项目文件/Skill存储系统/运行数据/自媒体操盘手/local-data-20260902/config/runtime.json";

// 已核实的供应商单价（人民币/张），按 上游模型名 + provider 区分渠道。
const SUPPLIER_FLOOR = [
  { model: "gpt-image-2", provider: "openai_compat", price: 0.05, source: "token.secure-skill.com/pricing image-2-1k & adobe-image2-mid 组 1K/2K/4K 均 0.05" },
  { model: "gpt-image-2.5-flare", provider: "openai_compat", price: 0.16, source: "token.secure-skill.com/pricing gpt-image-2.5 组每次 0.16" },
  { model: "gpt-image-2.5-sunburst", provider: "openai_compat", price: 0.16, source: "token.secure-skill.com/pricing gpt-image-2.5 组每次 0.16" },
  { model: "nano-banana-2", provider: "secure_skill_images", price: 0.05, source: "token.secure-skill.com/pricing 图片模型组 0.05" },
  { model: "nano-banana-pro", provider: "secure_skill_images", price: 0.05, source: "token.secure-skill.com/pricing 图片模型组 0.05" },
  { model: "nano-banana-pro", provider: "lconai", price: 0.30, source: "n.lconai.com/api/pricing 0.30" },
  { model: "gemini-3.1-flash-image", provider: "lconai", price: 0.20, source: "n.lconai.com/api/pricing 0.20" },
  { model: "doubao-seedream-5-0-pro-260628", provider: "volcengine", price: 0.60, source: "火山方舟 2K 档(2816x1584, >236万像素) 0.60 元/张" },
];

function normalizeConfig(row) {
  const config = row.api_protocol_config && typeof row.api_protocol_config === "object" ? row.api_protocol_config : {};
  const costs = config.resolution_cost_prices || config.resolutionCostPrices || {};
  const prices = config.resolution_prices || config.resolutionPrices || {};
  const options = config.resolution_options || config.resolutionOptions || Object.keys(costs);
  const byKey = {};
  const lower = (source) => Object.fromEntries(Object.entries(source || {}).map(([k, v]) => [String(k).toUpperCase(), Number(v)]));
  for (const [k, v] of Object.entries(lower(costs))) byKey[k] = { ...(byKey[k] || {}), cost: v };
  for (const [k, v] of Object.entries(lower(prices))) byKey[k] = { ...(byKey[k] || {}), sell: v };
  return { options: options.map((o) => String(o).toUpperCase()), byKey };
}

export function priceFloorViolations(rows, floorTable = SUPPLIER_FLOOR) {
  const violations = [];
  const unverified = [];
  for (const row of rows) {
    const { options, byKey } = normalizeConfig(row);
    const floor = floorTable.find((f) => f.model === row.model_name && f.provider === row.provider);
    if (!floor) { unverified.push(`${row.name}(${row.provider}/${row.model_name})`); continue; }
    for (const option of options.length ? options : Object.keys(byKey)) {
      const entry = byKey[option];
      if (!entry) continue;
      if (Number.isFinite(entry.cost) && entry.cost + 1e-9 < floor.price) {
        violations.push(`${row.name} ${option}: 成本 ${entry.cost} < 供应商 ${floor.price}（${floor.source}）`);
      }
      if (Number.isFinite(entry.cost) && Number.isFinite(entry.sell) && entry.sell + 1e-9 < entry.cost) {
        violations.push(`${row.name} ${option}: 售价 ${entry.sell} < 成本 ${entry.cost}`);
      }
    }
  }
  return { violations, unverified };
}

async function loadActiveRows() {
  const runtime = JSON.parse(fs.readFileSync(RUNTIME_FILE, "utf8").replace(/^\uFEFF/u, ""));
  const response = await fetch(`${runtime.supabaseUrl}/rest/v1/cover_models?select=name,model_name,provider,is_active,api_protocol_config&is_active=eq.true`, {
    headers: { apikey: runtime.serviceRoleKey, Authorization: `Bearer ${runtime.serviceRoleKey}` },
  });
  if (!response.ok) throw new Error(`读取模型池失败 HTTP ${response.status}`);
  return response.json();
}

function selfTest() {
  const rows = [
    { name: "ok", model_name: "gpt-image-2", provider: "openai_compat", api_protocol_config: { resolution_options: ["1K", "2K"], resolution_cost_prices: { "1K": 0.05, "2K": 0.05 }, resolution_prices: { "1K": 0.1, "2K": 0.1 } } },
    { name: "under-cost", model_name: "gpt-image-2", provider: "openai_compat", api_protocol_config: { resolution_options: ["1K"], resolution_cost_prices: { "1K": 0.01 }, resolution_prices: { "1K": 0.1 } } },
    { name: "negative-margin", model_name: "nano-banana-pro", provider: "lconai", api_protocol_config: { resolution_options: ["1K"], resolution_cost_prices: { "1K": 0.3 }, resolution_prices: { "1K": 0.2 } } },
  ];
  const { violations } = priceFloorViolations(rows);
  const text = violations.join("\n");
  if (!text.includes("under-cost") || !text.includes("negative-margin") || text.includes("ok ")) {
    throw new Error(`自检失败：\n${text}`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  selfTest();
  const rows = await loadActiveRows();
  const { violations, unverified } = priceFloorViolations(rows);
  console.log(JSON.stringify({ checked: rows.length, violations, unverified }, null, 2));
  if (violations.length) {
    console.error(`FAIL: ${violations.length} 处价格低于底线或亏本`);
    process.exit(1);
  }
  console.log("PASS: 所有已核实渠道的成本不低于供应商价，售价不低于成本");
}
