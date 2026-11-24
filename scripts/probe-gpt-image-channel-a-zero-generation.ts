import fs from "node:fs/promises";
import pg from "pg";
import { resolveProviderSecret } from "../src/lib/provider-secret";

async function main() {
  const runtimePath = process.env.LOCAL_ACCEPTANCE_RUNTIME_PATH?.trim()
    || "F:/总项目文件/Skill存储系统/运行数据/自媒体操盘手/local-data-20260902/config/runtime.json";
  const runtime = JSON.parse((await fs.readFile(runtimePath, "utf8")).replace(/^﻿/u, ""));
  const client = new pg.Client({ ...runtime.ownerConnection, application_name: "kimi-gpt-image-channel-a-probe", query_timeout: 30_000 });
  await client.connect();
  try {
    const result = await client.query(
      `SELECT id,model_name,api_endpoint,api_key,is_active,is_hidden FROM public.cover_models
       WHERE api_endpoint LIKE '%token.secure-skill.com%' AND model_name LIKE 'gpt-image%' ORDER BY model_name`,
    );
    for (const row of result.rows) {
      const secret = resolveProviderSecret(row.api_key);
      if (!secret) { console.log(`${row.model_name}: SECRET_UNRESOLVED`); continue; }
      const base = String(row.api_endpoint).replace(/\/+$/, "");
      const url = base.endsWith("/v1") ? `${base}/models` : `${base}/v1/models`;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 15_000);
      try {
        const response = await fetch(url, { headers: { Authorization: `Bearer ${secret}` }, signal: controller.signal });
        const text = await response.text();
        const snippet = text.slice(0, 160).replace(/sk-[A-Za-z0-9_-]+/g, "sk-***").replace(/\s+/g, " ");
        console.log(`${row.model_name} (active=${row.is_active},hidden=${row.is_hidden}): HTTP ${response.status} ${snippet}`);
      } catch (error) {
        console.log(`${row.model_name}: FETCH_ERROR ${(error as Error).message}`);
      } finally {
        clearTimeout(timer);
      }
    }
  } finally {
    await client.end();
  }
}

main().catch((error) => { console.error("PROBE_FAILED:", (error as Error).message); process.exit(1); });
