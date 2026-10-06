import assert from "node:assert/strict";

import { TencentCOSProvider } from "../src/storage/object/providers/tencent-cos";

type PutObjectParams = Record<string, unknown>;

async function main() {
  const provider = new TencentCOSProvider();
  await provider.initialize({
    secretId: "fixture-secret-id",
    secretKey: "fixture-secret-key",
    bucket: "fixture-bucket-1234567890",
    region: "ap-guangzhou",
  });
  const calls: PutObjectParams[] = [];
  (provider as unknown as { cos: { putObject: (params: PutObjectParams, callback: (error: null, data: object) => void) => void } }).cos = {
    putObject(params, callback) {
      calls.push(params);
      callback(null, {});
    },
  };

  const publicResult = await provider.upload(Buffer.from("public fixture"), "public.txt", "text/plain", {
    category: "other",
    prefix: "fixtures/",
    fileName: "public.txt",
    publicRead: true,
  });
  const privateResult = await provider.upload(Buffer.from("private fixture"), "private.txt", "text/plain", {
    category: "other",
    prefix: "fixtures/",
    fileName: "private.txt",
  });

  assert.equal(calls.length, 2);
  assert.equal(calls[0]!.ACL, "public-read", "explicit publicRead must set COS object ACL");
  assert.equal(Object.hasOwn(calls[1]!, "ACL"), false, "private upload must not send any ACL override");
  assert.equal(publicResult.isPublic, true);
  assert.match(publicResult.url, /^https:\/\/fixture-bucket-1234567890\.cos\.ap-guangzhou\.myqcloud\.com\/fixtures\//u);
  assert.equal(new URL(publicResult.url).search, "");
  assert.equal(privateResult.isPublic, false);
  assert.equal(privateResult.url, "");

  console.log(JSON.stringify({
    event: "tencent-cos-public-read-contract-passed",
    network_calls: 0,
    public_acl: calls[0]!.ACL,
    private_acl_present: Object.hasOwn(calls[1]!, "ACL"),
    public_url_has_query: Boolean(new URL(publicResult.url).search),
  }));
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
