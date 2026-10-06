import assert from "node:assert/strict";
import { parseImageDataUrl } from "../src/lib/image-data-url";

const source = Buffer.alloc(6 * 1024 * 1024, 0xa5);
const dataUrl = `data:image/png;base64,${source.toString("base64")}`;
const parsed = parseImageDataUrl(dataUrl);

assert.ok(parsed);
assert.equal(parsed.mimeType, "image/png");
assert.equal(parsed.extension, "png");
assert.equal(parsed.bytes.byteLength, source.byteLength);
assert.deepEqual(parsed.bytes.subarray(0, 32), source.subarray(0, 32));
assert.equal(parseImageDataUrl("data:text/plain;base64,SGVsbG8="), null);
assert.equal(parseImageDataUrl("data:image/png,not-base64"), null);
assert.equal(parseImageDataUrl("https://example.com/image.png"), null);

console.log(JSON.stringify({
  ok: true,
  source_bytes: source.byteLength,
  encoded_characters: dataUrl.length,
  regression: "large Base64 image data URL parses without recursive regular-expression overflow",
}, null, 2));
