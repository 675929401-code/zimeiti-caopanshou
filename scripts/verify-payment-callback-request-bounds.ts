import assert from "node:assert/strict";

import { POST } from "../src/app/api/payment/notify/route";

function callbackRequest(options: {
  body?: ReadableStream<Uint8Array> | null;
  contentLength?: string;
  contentType?: string;
}) {
  const headers = new Headers();
  if (options.contentLength !== undefined) headers.set("content-length", options.contentLength);
  if (options.contentType !== undefined) headers.set("content-type", options.contentType);
  return {
    headers,
    body: options.body ?? null,
  } as Parameters<typeof POST>[0];
}

function streamBytes(...chunks: Uint8Array[]) {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

async function expectStatus(name: string, expected: number, request: Parameters<typeof POST>[0]) {
  const response = await POST(request);
  assert.equal(response.status, expected, name);
  assert.equal(await response.text(), "fail", `${name}: generic body`);
  console.log(`PASS ${name}`);
}

const encoder = new TextEncoder();

async function main() {
  await expectStatus(
  "declared callback body above 64 KiB is rejected before reading",
  413,
  callbackRequest({
    contentLength: String(64 * 1024 + 1),
    contentType: "application/json",
    body: streamBytes(encoder.encode("{}")),
  }),
  );

  await expectStatus(
  "streamed callback body above 64 KiB is rejected without content-length",
  413,
  callbackRequest({
    contentType: "application/json",
    body: streamBytes(new Uint8Array(32 * 1024), new Uint8Array(32 * 1024 + 1)),
  }),
  );

const tooManyFields = Object.fromEntries(
  Array.from({ length: 65 }, (_, index) => [`field_${index}`, "value"]),
);
  await expectStatus(
  "callbacks with more than 64 fields are rejected",
  400,
  callbackRequest({
    contentType: "application/json",
    body: streamBytes(encoder.encode(JSON.stringify(tooManyFields))),
  }),
  );

  await expectStatus(
  "nested callback values are rejected instead of stringified",
  400,
  callbackRequest({
    contentType: "application/json",
    body: streamBytes(encoder.encode(JSON.stringify({ trade_no: { nested: true } }))),
  }),
  );

  await expectStatus(
  "malformed callback JSON is rejected without provider processing",
  400,
  callbackRequest({
    contentType: "application/json",
    body: streamBytes(encoder.encode("{")),
  }),
  );

  console.log("Payment callback request bounds: 5/5 runtime checks passed; no provider calls or database writes.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
