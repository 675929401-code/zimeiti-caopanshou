#!/usr/bin/env node
import assert from "node:assert/strict";

const origin = String(process.env.LOCAL_NAV_ORIGIN || "http://127.0.0.1:5000").replace(/\/+$/u, "");
const token = String(process.env.R267_CUSTOMER_TOKEN || "").trim();

export async function main() {
  assert.equal(origin, "http://127.0.0.1:5000", "LOCAL_ONLY_ORIGIN_REQUIRED");
  assert.ok(token, "LOCAL_CUSTOMER_TOKEN_REQUIRED");
  const headers = { Authorization: `Bearer ${token}` };
  const get = await fetch(`${origin}/api/admin/workspace-models`, { headers, signal: AbortSignal.timeout(15_000) });
  assert.equal(get.status, 403, "ORDINARY_USER_READ_ADMIN_ROUTING");
  const post = await fetch(`${origin}/api/admin/workspace-models`, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({ action: "reorder", kind: "video", surface: "storyboard-video", modelIds: ["forbidden"] }),
    signal: AbortSignal.timeout(15_000),
  });
  assert.equal(post.status, 403, "ORDINARY_USER_WROTE_ADMIN_ROUTING");
  console.log(JSON.stringify({ passed: true, readStatus: get.status, writeStatus: post.status, databaseWrites: 0, providerCalls: 0 }));
}

if (import.meta.url === new URL(`file://${process.argv[1].replace(/\\/gu, "/")}`).href) await main();
