import http from "node:http";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { LOCAL_PREVIEW_RUNTIME_FILE, validateLocalPreviewRuntime } from "./start-local-data-preview.mjs";

// The callback process stays available when the local UI is rebuilt. Point its
// database clients at the validated local order book before loading the handler.
const local = validateLocalPreviewRuntime(JSON.parse(await readFile(LOCAL_PREVIEW_RUNTIME_FILE, "utf8")));
Object.assign(process.env, {
  LOCAL_ACCEPTANCE_PREVIEW: "true", LOCAL_RUNTIME_PROFILE: "local-acceptance",
  COZE_SUPABASE_URL: local.supabaseUrl, COZE_SUPABASE_SERVICE_ROLE_KEY: local.serviceRoleKey,
  COZE_SUPABASE_ANON_KEY: local.anonKey, DATABASE_URL: local.databaseUrl,
  SHARED_CONFIGURATION_ENABLED: "1", SHARED_CONFIGURATION_ID: "local-acceptance",
  SHARED_CONFIGURATION_SUPABASE_URL: local.supabaseUrl, SHARED_CONFIGURATION_SERVICE_ROLE_KEY: local.serviceRoleKey,
});
const require = createRequire(new URL("../package.json", import.meta.url));
require("tsx/cjs");
const { NextRequest } = require("next/server");
const { POST: receiveNotification } = require("./src/app/api/payment/preview-notify/route.ts");
const callbackUrl = "http://127.0.0.1:5000/api/payment/preview-notify";
const limit = 64 * 1024;
const relay = http.createServer({ requestTimeout: 10000, headersTimeout: 8000, maxHeaderSize: 8192 }, async (request, response) => {
  response.setHeader("Cache-Control", "no-store");
  if (request.method !== "POST" || request.url !== "/__preview-payment/notify") {
    response.writeHead(404).end();
    return;
  }
  let size = 0;
  const chunks = [];
  try {
    for await (const chunk of request) {
      size += chunk.length;
      if (size > limit) {
        response.writeHead(413).end();
        return;
      }
      chunks.push(chunk);
    }
    const headers = { "content-type": request.headers["content-type"] || "application/x-www-form-urlencoded" };
    const probe = request.headers["x-local-payment-route-check"];
    const bodyBytes = Buffer.concat(chunks);
    let upstream;
    if (typeof probe === "string" && /^[a-f0-9-]{36}$/i.test(probe)) {
      // The single-use checkout challenge lives in the UI server that issued it.
      headers["x-local-payment-route-check"] = probe;
      upstream = await fetch(callbackUrl, {
        method: "POST", headers, body: bodyBytes, redirect: "error", signal: AbortSignal.timeout(14000),
      });
    } else {
      upstream = await receiveNotification(new NextRequest(callbackUrl, { method: "POST", headers, body: bodyBytes }));
    }
    const body = await upstream.text();
    response.writeHead(upstream.status, { "Content-Type": upstream.headers.get("content-type") || "text/plain" });
    response.end(body);
  } catch {
    if (!response.headersSent) response.writeHead(503);
    response.end("fail");
  }
});
relay.maxConnections = 24;
relay.listen(19571, "127.0.0.1");
