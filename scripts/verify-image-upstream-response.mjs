#!/usr/bin/env node
import assert from "node:assert/strict";
import {
  ImageUpstreamResponseTooLargeError,
  parseImageSseFrames,
  parseImageUpstreamResponse,
  readImageUpstreamResponseText,
} from "../src/lib/image-upstream-response.ts";

const json = parseImageUpstreamResponse('{"data":[{"url":"https://example.invalid/result.png"}]}', "application/json");
assert.equal(json.format, "json");
assert.equal(json.error, null);
assert.equal(json.payload?.data?.[0]?.url, "https://example.invalid/result.png");

const sseError = parseImageUpstreamResponse(
  'event: error\ndata: {"error":{"code":"no_available_channel","message":"No available compatible accounts"}}\n\n',
  "text/event-stream; charset=utf-8",
);
assert.equal(sseError.format, "sse");
assert.deepEqual(sseError.error, { code: "no_available_channel", message: "No available compatible accounts" });

const sseSuccess = parseImageUpstreamResponse(
  'event: result\ndata: {"data":[{"b64_json":"abc"}]}\n\nevent: done\ndata: [DONE]\n\n',
  "text/event-stream",
);
assert.equal(sseSuccess.error, null);
assert.equal(sseSuccess.payload?.data?.[0]?.b64_json, "abc");

const multiFrame = parseImageUpstreamResponse(
  'event: result\ndata: {"data":[{"url":"https://example.invalid/early.png"}]}\n\n'
    + 'event: progress\ndata: {"status":"completed","progress":100}\n\n'
    + 'event: result\ndata: {"data":[{"url":"https://example.invalid/late.png"}]}\n\n',
  "text/event-stream",
);
assert.equal(multiFrame.error, null);
assert.deepEqual(multiFrame.payload?.data, [
  { url: "https://example.invalid/early.png" },
  { url: "https://example.invalid/late.png" },
]);
assert.equal(multiFrame.payload?.status, "completed");

const missingBlankLines = parseImageSseFrames(
  'event: result\ndata: {"data":[{"url":"https://example.invalid/one.png"}]}\n'
    + 'data: {"status":"completed"}\n',
);
assert.equal(missingBlankLines.length, 2);
assert.equal(missingBlankLines[0].payload.data[0].url, "https://example.invalid/one.png");
assert.equal(missingBlankLines[1].payload.status, "completed");

const bounded = await readImageUpstreamResponseText(new Response("12345"), 5);
assert.equal(bounded, "12345");
await assert.rejects(
  () => readImageUpstreamResponseText(new Response("123456"), 5),
  ImageUpstreamResponseTooLargeError,
);

const invalid = parseImageUpstreamResponse("upstream proxy returned an HTML page", "text/html");
assert.equal(invalid.format, "invalid");
assert.equal(invalid.payload, null);

console.log(JSON.stringify({ result: "PASS", cases: 8, providerRequests: 0 }));
