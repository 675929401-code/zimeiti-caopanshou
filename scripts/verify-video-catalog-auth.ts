import assert from "node:assert/strict";
import { readVideoModelCatalog } from "../src/lib/video-model-catalog";
import { SafeFetchError } from "../src/lib/safe-fetch";

async function main() {
  const lookup = async () => [{ address: "8.8.8.8", family: 4 }];
  let calls = 0;
  const fetch = async (_url: string | URL, init?: RequestInit) => {
    calls++;
    assert.equal(init?.method, "GET");
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer fixture-key");
    assert.equal(init?.redirect, "manual");
    return Response.json({ data: [{ id: "omni_flash_8s" }] });
  };
  assert.deepEqual(await readVideoModelCatalog("https://example.com/v1/models", "fixture-key", { lookup, fetch }), { data: [{ id: "omni_flash_8s" }] });
  assert.equal(calls, 1);
  for (const status of [302, 401, 403, 429]) {
    let attempts = 0;
    await assert.rejects(readVideoModelCatalog("https://example.com/v1/models", "fixture-key", {
      lookup, fetch: async () => { attempts++; return new Response(null, { status, headers: { location: "https://other.example/v1/models" } }); },
    }), error => error instanceof SafeFetchError && error.upstreamStatus === status);
    assert.equal(attempts, 1, "No credential-bearing redirect or retry");
  }
  await assert.rejects(readVideoModelCatalog("https://example.com/v1/models", "fixture-key", {
    lookup, fetch: async () => new Response("x".repeat(2 * 1024 * 1024 + 1)),
  }), /MODEL_CATALOG_TOO_LARGE/);
  await assert.rejects(readVideoModelCatalog("http://127.0.0.1/v1/models", "fixture-key", { lookup, fetch }));
  console.log("PASS: directory authentication, redirects, status codes, size limit, private-address denial");
}
void main();
