import fs from "node:fs/promises";
import pg from "pg";
import { resolveProviderSecret } from "../src/lib/provider-secret";

async function main() {
  const runtimePath = process.env.LOCAL_ACCEPTANCE_RUNTIME_PATH?.trim()
    || "F:/总项目文件/Skill存储系统/运行数据/自媒体操盘手/local-data-20260902/config/runtime.json";
  const runtime = JSON.parse((await fs.readFile(runtimePath, "utf8")).replace(/^﻿/u, ""));
  const client = new pg.Client({ ...runtime.ownerConnection, application_name: "kimi-channel-a-log", query_timeout: 30_000 });
  await client.connect();
  try {
    const result = await client.query(
      `SELECT model_name,api_endpoint,api_key FROM public.cover_models
       WHERE api_endpoint LIKE '%token.secure-skill.com%' AND model_name='gpt-image-2.5-sunburst' LIMIT 1`,
    );
    const row = result.rows[0];
    if (!row) throw new Error("NO_ROW");
    const secret = resolveProviderSecret(row.api_key);
    const base = String(row.api_endpoint).replace(/\/+$/, "").replace(/\/v1$/, "");
    const res = await fetch(`${base}/api/log/token`, { headers: { Authorization: `Bearer ${secret}` }, signal: AbortSignal.timeout(16_000) });
    const text = await res.text();
    const sanitized = text.replace(/sk-[A-Za-z0-9_-]+/g, "sk-***");
    console.log("http_status:", res.status);
    try {
      const payload = JSON.parse(sanitized);
      const rows = Array.isArray(payload.data) ? payload.data : payload.data?.items;
      if (Array.isArray(rows)) {
        console.log("success:", payload.success, "rows:", rows.length);
        for (const r of rows.slice(0, 12)) {
          console.log(JSON.stringify({ model: r.model_name, type: r.type, quota: r.quota, use_time: r.use_time, created_at: r.created_at, request_id: r.request_id, content: String(r.content || "").slice(0, 60) }));
        }
      } else {
        console.log("payload_head:", sanitized.slice(0, 300));
      }
    } catch {
      console.log("body_head:", sanitized.slice(0, 300));
    }
  } finally {
    await client.end();
  }
}

main().catch((error) => { console.error("LOG_READ_FAILED:", (error as Error).message); process.exit(1); });
