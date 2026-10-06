import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type { Writable } from "node:stream";
import { TencentCOSProvider } from "../src/storage/object/providers/tencent-cos";
import { verifyImagePublicationObject } from "../src/lib/image-model-publication";

type GetObject = (params: { Bucket: string; Region: string; Key: string; Output: Writable }, callback: (error: Error | null, data?: { statusCode: number }) => void) => void;
function provider(getObject: GetObject) {
  const result = new TencentCOSProvider();
  Object.assign(result, { bucket: "configured-fixture-bucket", region: "ap-guangzhou", cos: { getObject } });
  return result;
}

async function main() {
  const valid = Buffer.from("/9j/2wBDAAYEBQYFBAYGBQYHBwYIChAKCgkJChQODwwQFxQYGBcUFhYaHSUfGhsjHBYWICwgIyYnKSopGR8tMC0oMCUoKSj/2wBDAQcHBwoIChMKChMoGhYaKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCj/wAARCAAQABgDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAX/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAAX/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCAAopAAD//2Q==", "base64");
  const key = "images/generated/fixture/original.jpg";
  let requests = 0;
  const good = provider((params, callback) => {
    requests++;
    assert.equal(params.Bucket, "configured-fixture-bucket");
    assert.equal(params.Key, key);
    assert.equal(params.Region, "ap-guangzhou");
    params.Output.end(valid);
    callback(null, { statusCode: 200 });
  });
  assert.deepEqual(await good.readBounded(key, valid.length, 1_000), valid);
  for (const invalid of ["", "/object", "../object", "images/../object", "https://169.254.169.254/object", "images\\object"]) {
    await assert.rejects(good.readBounded(invalid, valid.length, 1_000), /STORAGE_OBJECT_KEY_INVALID/u);
  }
  for (const [size, timeout] of [[0, 1_000], [26 * 1024 * 1024, 1_000], [valid.length, 0], [valid.length, 60_001]]) {
    await assert.rejects(good.readBounded(key, size, timeout), /STORAGE_READ_LIMIT_INVALID/u);
  }
  assert.equal(requests, 1);
  await assert.rejects(good.readBounded(key, valid.length - 1, 1_000), /STORAGE_OBJECT_TOO_LARGE/u);
  const delayedError = provider((params, callback) => {
    params.Output.end(valid);
    setTimeout(() => callback(null, { statusCode: 403 }), 5);
  });
  await assert.rejects(delayedError.readBounded(key, valid.length, 1_000), /STORAGE_OBJECT_READ_FAILED/u);
  const noReceipt = provider(params => { params.Output.end(valid); });
  await assert.rejects(noReceipt.readBounded(key, valid.length, 15), /STORAGE_READ_TIMEOUT/u);
  const networkError = provider((_params, callback) => callback(new Error("fixture network error")));
  await assert.rejects(networkError.readBounded(key, valid.length, 1_000), /STORAGE_OBJECT_READ_FAILED/u);

  const storage = {
    async head() { return { size: valid.length, contentType: "image/jpeg", lastModified: new Date(0) }; },
    async readBounded(ownedKey: string, bytes: number, timeout: number, type: string) {
      assert.equal(type, "tencent_cos");
      assert.equal(timeout, 20_000);
      return good.readBounded(ownedKey, bytes, timeout);
    },
  };
  const evidence = await verifyImagePublicationObject(key, storage);
  assert.deepEqual(evidence, { size: valid.length, contentType: "image/jpeg", width: 24, height: 16, sha256: createHash("sha256").update(valid).digest("hex") });
  await assert.rejects(verifyImagePublicationObject(key, { ...storage, async readBounded() { return valid.subarray(0, valid.length - 1); } }));
  await assert.rejects(verifyImagePublicationObject(key, { ...storage, async readBounded() { return Buffer.alloc(valid.length); } }));
  await assert.rejects(verifyImagePublicationObject(key, { ...storage, async head() { return { size: valid.length, contentType: "image/png", lastModified: new Date(0) }; } }));
  await assert.rejects(verifyImagePublicationObject(key, { ...storage, async head() { return { size: 26 * 1024 * 1024, contentType: "image/jpeg", lastModified: new Date(0) }; }, async readBounded() { assert.fail("Oversized object must not be read"); } }));
  console.log(JSON.stringify({ status: "PASS", authenticatedObjectRead: true, sizeTimeoutAndHttpStatusEnforced: true, decodedBytesAndDigestVerified: true, invalidAndIncompleteImagesRejected: true }));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
