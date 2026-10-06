import assert from "node:assert/strict";
import { isBlockedIpAddress, SafeFetchError, safeFetch } from "../src/lib/safe-fetch";

const imageResponse = () => new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), {
  status: 200,
  headers: { "content-type": "image/png" },
});

const reservedLookup = async () => [{ address: "198.18.0.240", family: 4 }];

async function main() {
assert.equal(isBlockedIpAddress("198.18.0.240"), true);
assert.equal(isBlockedIpAddress("198.19.255.255"), true);
const trustedHostnames = [
  "source.openclaw-token.shop",
  "flow.secure-skill.com",
  "cdn.openaicn.com",
];
for (const hostname of trustedHostnames) {
  const trusted = await safeFetch(`https://${hostname}/generated.png`, {
    allowedContentTypes: ["image/png"],
    trustedHostnames,
  }, {
    lookup: reservedLookup,
    fetch: async () => imageResponse(),
  });
  assert.equal(trusted.contentType, "image/png");
}

await assert.rejects(
  () => safeFetch("https://source.openclaw-token.shop/generated.png", {}, {
    lookup: reservedLookup,
    fetch: async () => imageResponse(),
  }),
  (error: unknown) => error instanceof SafeFetchError && error.code === "IP_FORBIDDEN",
);

await assert.rejects(
  () => safeFetch("https://source.openclaw-token.shop.evil.example/generated.png", {
    trustedHostnames: ["source.openclaw-token.shop"],
  }, {
    lookup: reservedLookup,
    fetch: async () => imageResponse(),
  }),
  (error: unknown) => error instanceof SafeFetchError && error.code === "IP_FORBIDDEN",
);

await assert.rejects(
  () => safeFetch("http://source.openclaw-token.shop/generated.png", {
    trustedHostnames: ["source.openclaw-token.shop"],
  }, {
    lookup: reservedLookup,
    fetch: async () => imageResponse(),
  }),
  (error: unknown) => error instanceof SafeFetchError && error.code === "IP_FORBIDDEN",
);

console.log(JSON.stringify({ passed: true, checks: trustedHostnames.length + 5 }));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
