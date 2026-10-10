import assert from "node:assert/strict";
import { inferVideoContentType, sniffVideoContentType } from "../src/lib/video-content-type";

let networkCalls = 0;
globalThis.fetch = (async () => {
  networkCalls += 1;
  throw new Error("NETWORK_FORBIDDEN");
}) as typeof fetch;

const mp4 = new Uint8Array([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]);
const mov = new Uint8Array([0, 0, 0, 20, 0x66, 0x74, 0x79, 0x70, 0x71, 0x74, 0x20, 0x20]);
const webm = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42]);

assert.equal(sniffVideoContentType(mp4), "video/mp4");
assert.equal(sniffVideoContentType(mov), "video/quicktime");
assert.equal(sniffVideoContentType(webm), "video/webm");
assert.equal(sniffVideoContentType(new Uint8Array([1, 2, 3, 4])), null);

assert.equal(inferVideoContentType({ declaredContentType: "video/mp4; charset=binary", sourceUrl: "https://relay.invalid/content" }), "video/mp4");
assert.equal(inferVideoContentType({ declaredContentType: "application/octet-stream", sourceUrl: "https://relay.invalid/file.webm" }), "video/webm");
assert.equal(inferVideoContentType({ declaredContentType: "application/octet-stream", sourceUrl: "https://relay.invalid/content", prefix: mp4 }), "video/mp4");
assert.equal(inferVideoContentType({ declaredContentType: "application/octet-stream", sourceUrl: "https://relay.invalid/content", cachedContentType: "video/webm" }), "video/webm");
assert.equal(inferVideoContentType({ declaredContentType: "application/octet-stream", sourceUrl: "https://relay.invalid/content" }), null);
assert.equal(networkCalls, 0);

console.log("PASS video content-type inference: declared, extension, MP4/MOV/WebM magic, cache, fail-closed unknown; network=0");
