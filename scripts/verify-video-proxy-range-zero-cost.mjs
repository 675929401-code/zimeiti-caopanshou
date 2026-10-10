import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";
import ts from "typescript";

const root = process.cwd();
const routePath = path.join(root, "src/app/api/video/proxy/route.ts");
const evidencePath = path.join(root, ".codex-evidence/video-proxy-range-zero-cost/report.json");
const source = await readFile(routePath, "utf8");
const beginMarker = "// VIDEO_PROXY_RANGE_CONTRACT_BEGIN";
const endMarker = "// VIDEO_PROXY_RANGE_CONTRACT_END";
const begin = source.indexOf(beginMarker);
const end = source.indexOf(endMarker);
assert.ok(begin >= 0 && end > begin, "Range contract markers are missing");

const contractSource = source.slice(begin + beginMarker.length, end);
const executable = ts.transpileModule(`${contractSource}\n;globalThis.__rangeContract = { parseSingleByteRange, buildVideoProxyResponseHeaders };`, {
  compilerOptions: { module: ts.ModuleKind.None, target: ts.ScriptTarget.ES2022 },
}).outputText;
const sandbox = { globalThis: {} };
vm.runInNewContext(executable, sandbox, { filename: "video-proxy-range-contract.js" });
const contract = sandbox.globalThis.__rangeContract;
assert.ok(contract, "Range contract could not be loaded from the route source");

let networkCalls = 0;
globalThis.fetch = async () => {
  networkCalls += 1;
  throw new Error("NETWORK_FORBIDDEN");
};

const checks = [];
function check(name, input, expected) {
  const actual = contract.buildVideoProxyResponseHeaders(input);
  assert.deepEqual(JSON.parse(JSON.stringify(actual)), expected, name);
  checks.push({ name, status: "PASS", actual });
}

const base = {
  upstreamContentLength: null,
  upstreamAcceptRanges: "bytes",
  contentType: "video/mp4",
};

check("closed range 206 and incorrect upstream length corrected", {
  ...base,
  requestRange: "bytes=10-19",
  upstreamStatus: 206,
  upstreamContentRange: "bytes 10-19/100",
  upstreamContentLength: "999",
}, { ok: true, headers: {
  "Cache-Control": "private, max-age=300",
  "Content-Disposition": "inline",
  "Referrer-Policy": "no-referrer",
  "Accept-Ranges": "bytes",
  "Content-Length": "10",
  "Content-Range": "bytes 10-19/100",
  "Content-Type": "video/mp4",
} });

check("open range 206", {
  ...base,
  requestRange: "bytes=20-",
  upstreamStatus: 206,
  upstreamContentRange: "bytes 20-49/100",
}, { ok: true, headers: {
  "Cache-Control": "private, max-age=300",
  "Content-Disposition": "inline",
  "Referrer-Policy": "no-referrer",
  "Accept-Ranges": "bytes",
  "Content-Length": "30",
  "Content-Range": "bytes 20-49/100",
  "Content-Type": "video/mp4",
} });

check("suffix range 206", {
  ...base,
  requestRange: "bytes=-25",
  upstreamStatus: 206,
  upstreamContentRange: "bytes 75-99/100",
}, { ok: true, headers: {
  "Cache-Control": "private, max-age=300",
  "Content-Disposition": "inline",
  "Referrer-Policy": "no-referrer",
  "Accept-Ranges": "bytes",
  "Content-Length": "25",
  "Content-Range": "bytes 75-99/100",
  "Content-Type": "video/mp4",
} });

check("unsatisfied range 416", {
  ...base,
  requestRange: "bytes=100-200",
  upstreamStatus: 416,
  upstreamContentRange: "bytes */100",
  upstreamContentLength: "0",
}, { ok: true, headers: {
  "Cache-Control": "private, no-store",
  "Content-Disposition": "inline",
  "Referrer-Policy": "no-referrer",
  "Accept-Ranges": "bytes",
  "Content-Range": "bytes */100",
  "Content-Length": "0",
  "Content-Type": "video/mp4",
} });

for (const [name, input, error] of [
  ["206 without Content-Range fails closed", { ...base, requestRange: "bytes=0-9", upstreamStatus: 206, upstreamContentRange: null }, "视频源返回了不完整的 Range 响应"],
  ["mismatched Content-Range fails closed", { ...base, requestRange: "bytes=0-9", upstreamStatus: 206, upstreamContentRange: "bytes 10-19/100" }, "视频源 Content-Range 与请求不匹配"],
  ["malformed Content-Range fails closed", { ...base, requestRange: "bytes=0-9", upstreamStatus: 206, upstreamContentRange: "bytes 0-10/*" }, "视频源返回了不完整的 Range 响应"],
  ["malformed 416 Content-Range fails closed", { ...base, requestRange: "bytes=100-", upstreamStatus: 416, upstreamContentRange: "bytes 100-99/100" }, "视频源返回了错误的 416 Content-Range"],
  ["upstream ignoring Range fails closed", { ...base, requestRange: "bytes=0-9", upstreamStatus: 200, upstreamContentRange: null }, "视频源忽略了 Range 请求"],
  ["upstream error is not treated as media", { ...base, requestRange: null, upstreamStatus: 503, upstreamContentRange: null }, "视频源响应状态无效"],
  ["unknown media type fails closed", { ...base, requestRange: null, upstreamStatus: 200, upstreamContentRange: null, contentType: null }, "视频源容器类型无法确认"],
]) {
  check(name, input, { ok: false, error });
}

check("200 passthrough sanitizes length and advertises byte ranges", {
  ...base,
  requestRange: null,
  upstreamStatus: 200,
  upstreamContentRange: null,
  upstreamContentLength: "00100",
}, { ok: true, headers: {
  "Cache-Control": "private, max-age=300",
  "Content-Disposition": "inline",
  "Referrer-Policy": "no-referrer",
  "Content-Type": "video/mp4",
  "Accept-Ranges": "bytes",
  "Content-Length": "100",
} });

assert.match(source, /status !== 206 && upstreamResp\.status !== 416/u, "route must preserve upstream 416");
assert.ok((source.match(/buildVideoProxyResponseHeaders\(\{/gu) || []).length >= 2, "route must apply the contract to 416 and successful media responses");
assert.match(source, /inferVideoContentType\(\{/u, "route must retain content-type correction and unknown-format rejection");
assert.equal(networkCalls, 0, "zero-cost verifier must not use the network");

const report = {
  schemaVersion: 1,
  contract: "VIDEO-COMPAT-01",
  generatedAt: new Date().toISOString(),
  result: "PASS",
  zeroNetwork: true,
  networkCalls,
  route: path.relative(root, routePath).replaceAll("\\", "/"),
  routeSha256: createHash("sha256").update(source).digest("hex"),
  checks,
};
await mkdir(path.dirname(evidencePath), { recursive: true });
await writeFile(evidencePath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(`PASS ${checks.length} deterministic video proxy Range checks; network=${networkCalls}`);
console.log(`evidence=${path.relative(root, evidencePath).replaceAll("\\", "/")}`);
