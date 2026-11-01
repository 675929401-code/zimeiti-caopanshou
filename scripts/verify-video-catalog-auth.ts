import assert from "node:assert/strict";
import { readVideoModelCatalog } from "../src/lib/video-model-catalog";
import { SafeFetchError } from "../src/lib/safe-fetch";
import type { PinnedFetch } from "../src/lib/safe-fetch-public-dns";

async function main() {
  const lookup = async () => [{ address: "8.8.8.8", family: 4 }];
  let calls = 0;
  const pinnedFetch: PinnedFetch = async (url, address, init) => {
    calls++;
    assert.equal(url.hostname, "example.com");
    assert.equal(address.address, "8.8.8.8");
    assert.equal(init?.method, "GET");
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer fixture-key");
    assert.equal(init?.redirect, "manual");
    return Response.json({ data: [{ id: "omni_flash_8s" }] });
  };
  const fetch = async () => { throw new Error("UNPINNED_CATALOG_FETCH_FORBIDDEN"); };
  assert.deepEqual(await readVideoModelCatalog("https://example.com/v1/models", "fixture-key", { lookup, fetch, pinnedFetch }), { data: [{ id: "omni_flash_8s" }] });
  assert.equal(calls, 1);
  for (const status of [302, 401, 403, 429]) {
    let attempts = 0;
    await assert.rejects(readVideoModelCatalog("https://example.com/v1/models", "fixture-key", {
      lookup, fetch, pinnedFetch: async () => { attempts++; return new Response(null, { status, headers: { location: "https://other.example/v1/models" } }); },
    }), error => error instanceof SafeFetchError && error.upstreamStatus === status);
    assert.equal(attempts, 1, "No credential-bearing redirect or retry");
  }
  await assert.rejects(readVideoModelCatalog("https://example.com/v1/models", "fixture-key", {
    lookup, fetch, pinnedFetch: async () => new Response("x".repeat(2 * 1024 * 1024 + 1)),
  }), /MODEL_CATALOG_TOO_LARGE/);
  await assert.rejects(readVideoModelCatalog("http://127.0.0.1/v1/models", "fixture-key", { lookup, fetch, pinnedFetch }));
  let blockedDispatches = 0;
  for (const address of ["198.18.0.1", "2001:2::1", "127.0.0.1", "10.0.0.1"]) {
    await assert.rejects(readVideoModelCatalog("https://example.com/v1/models", "fixture-key", {
      lookup: async () => [{ address: "8.8.8.8", family: 4 }, { address, family: address.includes(":") ? 6 : 4 }],
      fetch: async () => { blockedDispatches++; throw new Error("UNSAFE_FETCH"); },
      pinnedFetch: async () => { blockedDispatches++; throw new Error("UNSAFE_PIN"); },
    }), error => error instanceof SafeFetchError && error.code === "IP_FORBIDDEN");
  }
  await assert.rejects(readVideoModelCatalog("https://example.com/v1/models", "fixture-key", {
    lookup: async () => { throw new Error("resolver unavailable"); },
    fetch: async () => { blockedDispatches++; throw new Error("NO_FALLBACK"); },
    pinnedFetch: async () => { blockedDispatches++; throw new Error("NO_FALLBACK"); },
  }), error => error instanceof SafeFetchError && error.code === "DNS_LOOKUP_FAILED");
  assert.equal(blockedDispatches, 0);
  console.log("PASS: pinned directory authentication, redirects, status codes, size limit, all-answer private-address denial and no DNS fallback");
}
void main();
