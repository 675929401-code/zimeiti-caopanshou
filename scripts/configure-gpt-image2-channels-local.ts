import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";

import pg from "pg";

type JsonRecord = Record<string, unknown>;

const APPLY = process.argv.includes("--apply");
const RUNTIME_CONFIG = "F:/总项目文件/Skill存储系统/运行数据/自媒体操盘手/local-data-20260902/config/runtime.json";
const EVIDENCE_DIR = path.resolve(".codex-evidence/storyboard-gpt-image2-channels-20260920");
const RETIRED_PROVIDER = "retired_configuration";
const MODEL_NAME = "gpt-image-2";

const CHANNELS = [
  {
    id: "pending-cover-model-gpt-image-2-image-2-1k",
    name: "GPT Image 2 · A渠道低成本档（image-2-1k）",
    group: "image-2-1k",
    resolutions: ["1K"],
    defaultResolution: "1K",
    costs: { "1K": 0.05 },
    prices: { "1K": 0.10 },
    sortOrder: 81,
  },
  {
    id: "pending-cover-model-gpt-image-2-official",
    name: "GPT Image 2 · A渠道官方档（image2-官key）",
    group: "image2-官key",
    resolutions: ["1K", "2K", "4K"],
    defaultResolution: "2K",
    costs: { "1K": 0.15, "2K": 0.18, "4K": 0.20 },
    prices: { "1K": 0.20, "2K": 0.20, "4K": 0.30 },
    sortOrder: 82,
  },
  {
    id: "pending-cover-model-gpt-image-2-adobe-mid",
    name: "GPT Image 2 · A渠道低成本档（adobe-image2-mid）",
    group: "adobe-image2-mid",
    resolutions: ["1K", "2K"],
    defaultResolution: "2K",
    costs: { "1K": 0.05, "2K": 0.05 },
    prices: { "1K": 0.10, "2K": 0.10 },
    sortOrder: 83,
  },
] as const;

function safeEndpoint(value: unknown): string {
  const url = new URL(String(value || ""));
  assert.equal(url.protocol, "https:", "A channel endpoint must use HTTPS");
  assert.equal(url.hostname, "token.secure-skill.com", "A channel endpoint host mismatch");
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/u, "");
}

function protocolConfig(channel: typeof CHANNELS[number]): JsonRecord {
  return {
    protocol: "secure_skill_images",
    submit_path: "/v1/images/generations",
    response_format: "url",
    resolution_options: channel.resolutions,
    default_resolution: channel.defaultResolution,
    resolution_cost_prices: channel.costs,
    resolution_prices: channel.prices,
    aspect_ratios: ["16:9", "9:16", "1:1", "4:3", "3:4"],
    supports_reference_input: true,
    reference_input_mode: "multi",
    identity_reference_level: "multi-subject",
    max_reference_images: 8,
    max_character_references: 4,
    reference_capability_label: "多图参考 / 多角色一致性",
    workspace_surfaces: ["image-workbench", "storyboard-workbench", "cover-studio"],
    provider_channel: "A",
    provider_group_name: channel.group,
    credential_scope: "dedicated_group_key",
    adapter_contract: "secure_skill_images_v1",
    activation_state: "pending_real_canary",
    supplier_pricing_note: `A渠道 ${channel.group}；成本按分辨率；未完成真实付费验收前不公开`,
  };
}

function safeRow(row: JsonRecord | undefined) {
  if (!row) return null;
  const config = row.api_protocol_config && typeof row.api_protocol_config === "object"
    ? row.api_protocol_config as JsonRecord : {};
  return {
    id: row.id,
    name: row.name,
    modelName: row.model_name,
    provider: row.provider,
    endpoint: safeEndpoint(row.api_endpoint),
    credentialConfigured: Boolean(String(row.api_key || "").trim()),
    costPrice: Number(row.cost_price),
    sellingPrice: Number(row.selling_price),
    active: row.is_active === true,
    hidden: row.is_hidden === true,
    group: config.provider_group_name,
    resolutionCosts: config.resolution_cost_prices,
    resolutionPrices: config.resolution_prices,
    activationState: config.activation_state,
  };
}

async function readThreeCredentials(): Promise<string[]> {
  process.stderr.write("Waiting for three backend credentials on stdin...\n");
  if (process.stdin.isTTY && typeof process.stdin.setRawMode === "function") {
    const values = await new Promise<string[]>((resolve, reject) => {
      const lines: string[] = [];
      let current = "";
      let finished = false;
      const cleanup = () => {
        process.stdin.off("data", onData);
        process.stdin.setRawMode(false);
        process.stdin.pause();
      };
      const finish = (error?: Error) => {
        if (finished) return;
        finished = true;
        cleanup();
        if (error) reject(error);
        else resolve(lines);
      };
      const onData = (chunk: Buffer | string) => {
        for (const char of String(chunk)) {
          if (char === "\u0003") return finish(new Error("Credential input cancelled"));
          if (char === "\r" || char === "\n") {
            const value = current.trim();
            current = "";
            if (value) lines.push(value);
            if (lines.length === CHANNELS.length) return finish();
          } else {
            current += char;
          }
        }
      };
      process.stdin.setRawMode(true);
      process.stdin.resume();
      process.stdin.on("data", onData);
    });
    assert.equal(values.length, CHANNELS.length, "Exactly three credentials are required");
    for (const value of values) assert.match(value, /^sk-[A-Za-z0-9_-]{24,}$/u, "Credential format is invalid");
    assert.equal(new Set(values).size, CHANNELS.length, "Each channel must use a dedicated credential");
    return values;
  }
  const lines: string[] = [];
  const reader = createInterface({ input: process.stdin, crlfDelay: Infinity, terminal: false });
  for await (const line of reader) {
    const value = line.trim();
    if (!value) continue;
    lines.push(value);
    if (lines.length === CHANNELS.length) break;
  }
  reader.close();
  assert.equal(lines.length, CHANNELS.length, "Exactly three credentials are required");
  for (const value of lines) assert.match(value, /^sk-[A-Za-z0-9_-]{24,}$/u, "Credential format is invalid");
  assert.equal(new Set(lines).size, CHANNELS.length, "Each channel must use a dedicated credential");
  return lines;
}

async function probeCredential(endpoint: string, credential: string) {
  const modelsUrl = `${endpoint.replace(/\/v1$/u, "")}/v1/models`;
  const response = await fetch(modelsUrl, {
    headers: { Authorization: `Bearer ${credential}`, Accept: "application/json" },
    signal: AbortSignal.timeout(30_000),
  });
  const raw = await response.text();
  assert.ok(raw.length <= 5 * 1024 * 1024, "Provider catalog response is too large");
  let payload: JsonRecord = {};
  try { payload = JSON.parse(raw) as JsonRecord; } catch { /* Status is still reported safely. */ }
  const entries = Array.isArray(payload.data) ? payload.data : Array.isArray(payload.models) ? payload.models : [];
  const ids = entries.flatMap((entry) => {
    if (typeof entry === "string") return [entry];
    if (!entry || typeof entry !== "object") return [];
    const item = entry as JsonRecord;
    return [item.id, item.model, item.name].map((value) => String(value || "").trim()).filter(Boolean);
  });
  return {
    httpStatus: response.status,
    authenticationAccepted: response.status !== 401 && response.status !== 403,
    modelListed: ids.some((id) => id.toLowerCase() === MODEL_NAME),
    catalogEntryCount: entries.length,
  };
}

async function main() {
  const runtime = JSON.parse((await readFile(RUNTIME_CONFIG, "utf8")).replace(/^\uFEFF/u, "")) as JsonRecord;
  const ownerConnection = runtime.ownerConnection as pg.ClientConfig | undefined;
  assert.ok(ownerConnection, "Local owner connection is unavailable");
  assert.equal(ownerConnection.host, "127.0.0.1", "Local database host required");
  assert.equal(ownerConnection.database, "zimeiti_local", "Local database required");

  const db = new pg.Client(ownerConnection);
  await db.connect();
  try {
    const inventory = await db.query<JsonRecord>(`
      select id,name,model_name,provider,api_endpoint,api_key,cost_price,selling_price,
             is_active,is_hidden,sort_order,api_protocol_config
        from public.cover_models
       where model_name = $1
          or (is_active = true and api_endpoint ilike '%token.secure-skill.com%')
       order by id
    `, [MODEL_NAME]);
    const currentRows = inventory.rows;
    const endpointCandidates = currentRows
      .filter((row) => row.is_active === true && row.provider !== RETIRED_PROVIDER)
      .map((row) => safeEndpoint(row.api_endpoint));
    assert.ok(endpointCandidates.length > 0, "No active A-channel image endpoint is available as configuration source");
    const endpoint = endpointCandidates.find((value) => /\/v1$/u.test(value)) || endpointCandidates[0];

    const oldModel = currentRows.find((row) => row.id === "gpt-image-2-chA-1");
    const oldModelState = oldModel ? {
      id: oldModel.id,
      provider: oldModel.provider,
      endpointConfigured: Boolean(String(oldModel.api_endpoint || "").trim()),
      credentialConfigured: Boolean(String(oldModel.api_key || "").trim()),
      active: oldModel.is_active === true,
      hidden: oldModel.is_hidden === true,
    } : null;

    const plan = {
      checkedAt: new Date().toISOString(),
      localOnly: true,
      applyRequested: APPLY,
      endpoint,
      oldModelState,
      channels: CHANNELS.map((channel) => ({
        id: channel.id,
        group: channel.group,
        costs: channel.costs,
        prices: channel.prices,
        activeAfterWrite: false,
        hiddenAfterWrite: true,
      })),
      providerCatalogRequests: APPLY ? 3 : 0,
      paidGenerationRequests: 0,
    };

    await mkdir(EVIDENCE_DIR, { recursive: true });
    await writeFile(path.join(EVIDENCE_DIR, "plan.json"), `${JSON.stringify(plan, null, 2)}\n`, "utf8");
    if (!APPLY) {
      console.log(JSON.stringify({ ...plan, databaseWrites: 0 }, null, 2));
      return;
    }

    assert.ok(oldModelState && oldModelState.provider === RETIRED_PROVIDER
      && !oldModelState.endpointConfigured && !oldModelState.credentialConfigured
      && !oldModelState.active && oldModelState.hidden, "Old GPT Image 2 configuration is not safely retired");

    const credentials = await readThreeCredentials();
    const probes = [];
    for (let index = 0; index < CHANNELS.length; index += 1) {
      probes.push({ group: CHANNELS[index].group, ...(await probeCredential(endpoint, credentials[index])) });
    }
    const allReady = probes.every((probe) => probe.httpStatus === 200 && probe.authenticationAccepted && probe.modelListed);
    await writeFile(path.join(EVIDENCE_DIR, "provider-probes.json"), `${JSON.stringify({
      checkedAt: new Date().toISOString(),
      endpoint,
      probes,
      allReady,
      paidGenerationRequests: 0,
    }, null, 2)}\n`, "utf8");
    assert.equal(allReady, true, "At least one A-channel credential cannot access gpt-image-2; database remains unchanged");

    await db.query("begin");
    try {
      for (let index = 0; index < CHANNELS.length; index += 1) {
        const channel = CHANNELS[index];
        const existing = await db.query<JsonRecord>(
          "select id,is_active from public.cover_models where id=$1 for update",
          [channel.id],
        );
        assert.notEqual(existing.rows[0]?.is_active, true, `${channel.id} is already active and cannot be overwritten`);
        const config = protocolConfig(channel);
        await db.query(`
          insert into public.cover_models (
            id,name,model_name,provider,api_endpoint,api_key,cost_price,selling_price,
            is_active,is_hidden,supports_image_input,billing_mode,sort_order,api_protocol_config,updated_at
          ) values ($1,$2,$3,$4,$5,$6,$7,$8,false,true,true,'per_use',$9,$10::jsonb,now())
          on conflict (id) do update set
            name=excluded.name, model_name=excluded.model_name, provider=excluded.provider,
            api_endpoint=excluded.api_endpoint, api_key=excluded.api_key,
            cost_price=excluded.cost_price, selling_price=excluded.selling_price,
            is_active=false, is_hidden=true, supports_image_input=true,
            billing_mode='per_use', sort_order=excluded.sort_order,
            api_protocol_config=excluded.api_protocol_config, updated_at=now()
          where public.cover_models.is_active=false
        `, [
          channel.id,
          channel.name,
          MODEL_NAME,
          "openai_compat",
          endpoint,
          credentials[index],
          Number((channel.costs as Record<string, number>)[channel.defaultResolution]),
          Number((channel.prices as Record<string, number>)[channel.defaultResolution]),
          channel.sortOrder,
          JSON.stringify(config),
        ]);
      }
      await db.query("commit");
    } catch (error) {
      await db.query("rollback");
      throw error;
    }

    const after = await db.query<JsonRecord>(`
      select id,name,model_name,provider,api_endpoint,api_key,cost_price,selling_price,
             is_active,is_hidden,sort_order,api_protocol_config
        from public.cover_models
       where id = any($1::text[])
       order by sort_order
    `, [CHANNELS.map((channel) => channel.id)]);
    assert.equal(after.rows.length, CHANNELS.length, "Not all GPT Image 2 channels were persisted");
    const safeAfter = after.rows.map(safeRow);
    for (const row of safeAfter) {
      assert.ok(row?.credentialConfigured, `${row?.id} credential was not persisted`);
      assert.equal(row?.active, false, `${row?.id} must remain inactive before paid canary`);
      assert.equal(row?.hidden, true, `${row?.id} must remain hidden before paid canary`);
    }
    const evidence = {
      appliedAt: new Date().toISOString(),
      localOnly: true,
      database: "zimeiti_local",
      endpoint,
      probes,
      models: safeAfter,
      oldModelState,
      sourceSha256: createHash("sha256").update(await readFile(import.meta.filename)).digest("hex"),
      databaseWrites: CHANNELS.length,
      paidGenerationRequests: 0,
      publicationState: "pending_real_canary",
    };
    await writeFile(path.join(EVIDENCE_DIR, "applied.json"), `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
    console.log(JSON.stringify(evidence, null, 2));
  } finally {
    await db.end();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : "GPT_IMAGE2_CHANNEL_CONFIGURATION_FAILED");
  process.exitCode = 1;
});
