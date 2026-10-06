import assert from "node:assert/strict";

import { PlatformSettingValidationError } from "../src/lib/platform-settings-contract";
import {
  MAX_PAYMENT_CONFIG_BODY_BYTES,
  readBoundedPaymentConfigBody,
} from "../src/lib/server/payment-config-request-body";

const encoder = new TextEncoder();

function streamBytes(
  chunks: Uint8Array[],
  hooks: { onCancel?: () => void } = {},
): ReadableStream<Uint8Array> {
  let index = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index >= chunks.length) {
        controller.close();
        return;
      }
      controller.enqueue(chunks[index]);
      index += 1;
    },
    cancel() {
      hooks.onCancel?.();
    },
  }, { highWaterMark: 0 });
}

function requestBody(options: {
  chunks?: Uint8Array[];
  contentLength?: string;
  body?: ReadableStream<Uint8Array> | null;
}) {
  const headers = new Headers();
  if (options.contentLength !== undefined) headers.set("content-length", options.contentLength);
  return {
    headers,
    body: options.body === undefined ? streamBytes(options.chunks || []) : options.body,
  } as Pick<Request, "headers" | "body">;
}

async function expectCode(name: string, expectedCode: string, operation: () => Promise<unknown>) {
  await assert.rejects(operation, (error: unknown) => (
    error instanceof PlatformSettingValidationError && error.code === expectedCode
  ), name);
  console.log(`PASS ${name}`);
}

async function main() {
  let bodyAccesses = 0;
  const declaredOversizeRequest = {
    headers: new Headers({ "content-length": String(MAX_PAYMENT_CONFIG_BODY_BYTES + 1) }),
    get body() {
      bodyAccesses += 1;
      return streamBytes([encoder.encode("{}")]);
    },
  } as Pick<Request, "headers" | "body">;
  await expectCode(
    "declared body above 64 KiB is rejected before body access",
    "PAYMENT_CONFIG_REQUEST_TOO_LARGE",
    () => readBoundedPaymentConfigBody(declaredOversizeRequest),
  );
  assert.equal(bodyAccesses, 0);

  await expectCode(
    "non-decimal content-length is rejected",
    "PAYMENT_CONFIG_REQUEST_INVALID",
    () => readBoundedPaymentConfigBody(requestBody({ contentLength: "1e2", chunks: [encoder.encode("{}") ] })),
  );

  let streamedOversizeCancelled = false;
  await expectCode(
    "chunked body above 64 KiB is rejected and cancelled",
    "PAYMENT_CONFIG_REQUEST_TOO_LARGE",
    () => readBoundedPaymentConfigBody(requestBody({
      body: streamBytes(
        [new Uint8Array(32 * 1024), new Uint8Array(32 * 1024 + 1)],
        { onCancel: () => { streamedOversizeCancelled = true; } },
      ),
    })),
  );
  assert.equal(streamedOversizeCancelled, true);

  await expectCode(
    "forged small content-length cannot bypass streamed byte limit",
    "PAYMENT_CONFIG_REQUEST_TOO_LARGE",
    () => readBoundedPaymentConfigBody(requestBody({
      contentLength: "2",
      chunks: [new Uint8Array(MAX_PAYMENT_CONFIG_BODY_BYTES + 1)],
    })),
  );

  const prefix = encoder.encode('{"value":"');
  const suffix = encoder.encode('"}');
  const exactBody = new Uint8Array(MAX_PAYMENT_CONFIG_BODY_BYTES);
  exactBody.set(prefix, 0);
  exactBody.fill("x".charCodeAt(0), prefix.byteLength, exactBody.byteLength - suffix.byteLength);
  exactBody.set(suffix, exactBody.byteLength - suffix.byteLength);
  const exactResult = await readBoundedPaymentConfigBody(requestBody({
    contentLength: String(MAX_PAYMENT_CONFIG_BODY_BYTES),
    chunks: [exactBody],
  })) as { value?: string };
  assert.equal(exactResult.value?.length, MAX_PAYMENT_CONFIG_BODY_BYTES - prefix.byteLength - suffix.byteLength);
  console.log("PASS exactly 64 KiB of valid JSON is accepted");

  const multibyte = encoder.encode('{"value":"汉字"}');
  const splitInsideCodePoint = 11;
  const multibyteResult = await readBoundedPaymentConfigBody(requestBody({
    chunks: [multibyte.slice(0, splitInsideCodePoint), multibyte.slice(splitInsideCodePoint)],
  })) as { value?: string };
  assert.equal(multibyteResult.value, "汉字");
  console.log("PASS UTF-8 split across chunks is decoded intact");

  await expectCode(
    "malformed JSON is rejected",
    "PAYMENT_CONFIG_REQUEST_INVALID",
    () => readBoundedPaymentConfigBody(requestBody({ chunks: [encoder.encode("{")] })),
  );

  await expectCode(
    "stream read failure is normalized without exposing details",
    "PAYMENT_CONFIG_REQUEST_INVALID",
    () => readBoundedPaymentConfigBody(requestBody({
      body: new ReadableStream<Uint8Array>({
        pull(controller) {
          controller.error(new Error("fixture stream failure"));
        },
      }),
    })),
  );

  console.log(JSON.stringify({
    verifier: "payment-config-request-bounds",
    passed: 8,
    providerCalls: 0,
    databaseCalls: 0,
  }));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
