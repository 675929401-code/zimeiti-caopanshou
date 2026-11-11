#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import ts from "typescript";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const securityPath = "src/lib/security.ts", llmPath = "src/lib/llm-security.ts";
const securitySource = readFileSync(path.join(root, securityPath), "utf8");
const llmSource = readFileSync(path.join(root, llmPath), "utf8");
const evidence = path.join(root, ".codex-evidence/cover-rebuild-20261106-bc1a");
const diagnosis = JSON.parse(readFileSync(path.join(evidence, "supervisor-resume/product-analysis-diagnosis/original-security-zero-network.json"), "utf8"));
const hash = value => createHash("sha256").update(value).digest("hex");
let externalCalls = 0, authCalls = 0, timerRegistrations = 0;
const forbidden = () => { externalCalls++; throw new Error("Unplanned external I/O is forbidden"); };
const compile = (source, file) => {
  const result = ts.transpileModule(source, { fileName: file, reportDiagnostics: true,
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } });
  assert.deepEqual((result.diagnostics || []).filter(item => item.category === ts.DiagnosticCategory.Error), []);
  return result.outputText;
};
const securityModule = { exports: {} };
vm.runInNewContext(compile(securitySource, securityPath), {
  module: securityModule, exports: securityModule.exports, Buffer, Request, Response, URL,
  process: { env: {} }, fetch: forbidden, require: forbidden,
  setInterval: () => { timerRegistrations++; return 0; },
  console: { log: forbidden, warn: forbidden, error: forbidden },
}, { filename: securityPath, timeout: 5_000 });
const security = securityModule.exports;
const detectorInputs = [], logEvents = [];
const llmModule = { exports: {} };
vm.runInNewContext(compile(llmSource, llmPath), {
  module: llmModule, exports: llmModule.exports, Buffer, Request, Response, URL, process: { env: {} }, fetch: forbidden,
  require(name) {
    if (name === "@/lib/auth") return { verifyToken: () => { authCalls++; return forbidden(); } };
    if (name === "@/lib/security") return { ...security,
      detectSuspiciousBody(body, ...rest) { detectorInputs.push(body); return security.detectSuspiciousBody(body, ...rest); },
      // Only the persistence side effect is substituted. Actual detectors,
      // tracking functions and the full checkBodyInjection implementation run.
      logSecurityEvent: async event => { logEvents.push({ event_type: event.event_type, blocked: event.blocked }); },
    };
    return forbidden();
  },
}, { filename: llmPath, timeout: 5_000 });
const { omitSecurityScanFields, prepareSecurityScanBody, checkBodyInjection, runSecurityChecks } = llmModule.exports;
for (const value of [security.detectSuspiciousBody, omitSecurityScanFields, prepareSecurityScanBody, checkBodyInjection, runSecurityChecks]) assert.equal(typeof value, "function");
const clone = value => JSON.parse(JSON.stringify(value));
const plain = value => JSON.parse(JSON.stringify(value));
const freeze = value => { if (value && typeof value === "object") { Object.freeze(value); Object.values(value).forEach(freeze); } return value; };
const checks = [];
const sentinel = "[inline raster image bytes]";
const hit = "0xdeadbe";
const heads = { png: Buffer.from([137,80,78,71,13,10,26,10]), jpeg: Buffer.from([255,216,255]), webp: Buffer.from("RIFF0000WEBP", "ascii") };
// Signature fixtures are classification controls, not claims of decodable
// raster validity. The actual toothpaste PNG below is the real regression.
const syntheticUrl = mime => `data:image/${mime};base64,${Buffer.concat([heads[mime], Buffer.alloc(24 - heads[mime].length)]).toString("base64")}${hit}AAAA`;
const inline = (url = syntheticUrl("png")) => ({ messages: [{ role: "user", content: [{ type: "image_url", image_url: { url } }] }] });
const urlAt = body => body.messages[0].content[0].image_url.url;
const projectedScan = (body, skip = []) => security.detectSuspiciousBody(prepareSecurityScanBody(body, skip));
const expectOpaque = (url, label) => { const body = inline(url); assert.equal(urlAt(prepareSecurityScanBody(body)), sentinel, label); assert.equal(urlAt(body), url); checks.push(label); };
const expectFallback = (url, label) => {
  const body = inline(url), projected = prepareSecurityScanBody(body);
  assert.equal(urlAt(projected), url, label);
  assert.deepEqual(plain(security.detectSuspiciousBody(projected)), plain(security.detectSuspiciousBody(body)), label);
  if (url.includes(hit)) assert.equal(security.detectSuspiciousBody(projected).suspicious, true, label);
  checks.push(label);
};

const png = readFileSync(path.join(evidence, "qa-assets/toothpaste.png"));
assert.equal(hash(png), "d4e76e99003168ac8f79cc1a973df5933f265efe9a8b986516fef08ccf43336f");
const realUrl = `data:image/png;base64,${png.toString("base64")}`;
const actual = freeze({ agentName: "fixture", messages: [{ role: "system", content: "Inspect only the supplied image." },
  { role: "user", content: [{ type: "text", text: "保留牙膏包装，读取120 g与样品A07。" },
    { type: "text", text: "实际第1张图片，角色为商品。" }, { type: "image_url", image_url: { url: realUrl, detail: "high" } }] }] });
const actualBefore = hash(JSON.stringify(actual));
const raw = security.detectSuspiciousBody(actual);
assert.equal(raw.suspicious, true); assert.equal(raw.threatType, "sql_injection");
assert.equal(raw.field, "messages[1].content[2].image_url.url");
assert.equal(projectedScan(actual).suspicious, false);
assert.equal(hash(JSON.stringify(actual)), actualBefore);
assert.equal(prepareSecurityScanBody(actual).messages[1].content[2].image_url.detail, "high");
assert.equal(omitSecurityScanFields(actual).messages[1].content[2].image_url.url, realUrl, "The existing omission API must not acquire an implicit binary exemption");
checks.push("actual original toothpaste PNG reproduces the exact SQL false positive; scan-only projection passes and preserves body/data URL bytes, sibling detail and legacy omission semantics");
for (const mime of ["png", "jpeg", "webp"]) expectOpaque(syntheticUrl(mime), `${mime} signature and canonical Base64 at the exact multimodal path is opaque`);

for (const [name, attack] of [["sql", hit], ["xss", '<script>alert(1)</script>'], ["path", "../../private"]]) {
  for (const [place, modify] of [
    ["top-level text", body => { body.prompt = attack; }],
    ["system message text", body => { body.messages.unshift({ role: "system", content: attack }); }],
    ["adjacent content text", body => { body.messages[0].content.push({ type: "text", text: attack }); }],
    ["same part text", body => { body.messages[0].content[0].text = attack; }],
    ["part extra nested field", body => { body.messages[0].content[0].extra = { note: attack }; }],
    ["image_url.detail", body => { body.messages[0].content[0].image_url.detail = attack; }],
    ["image_url extra field", body => { body.messages[0].content[0].image_url.extra = { note: attack }; }],
    ["message role", body => { body.messages[0].role = attack; }],
  ]) {
    const body = inline(); modify(body);
    const before = JSON.stringify(body), result = projectedScan(body);
    assert.equal(result.suspicious, true, `${name} in ${place}`);
    assert.equal(result.threatType, name === "sql" ? "sql_injection" : name === "xss" ? "xss" : "path_traversal");
    assert.equal(JSON.stringify(body), before);
    checks.push(`${name} in ${place} remains scanned and blocked`);
  }
}
for (const [name, body] of [
  ["top-level lookalike image_url", { image_url: { url: syntheticUrl("png") } }],
  ["nested lookalike messages", { metadata: inline() }],
  ["messages object instead of array", { messages: { content: [{ type: "image_url", image_url: { url: syntheticUrl("png") } }] } }],
  ["message array instead of object", { messages: [[{ content: [{ type: "image_url", image_url: { url: syntheticUrl("png") } }] }]] }],
  ["content object instead of array", { messages: [{ content: { part: { type: "image_url", image_url: { url: syntheticUrl("png") } } } }] }],
  ["part array instead of object", { messages: [{ content: [[{ type: "image_url", image_url: { url: syntheticUrl("png") } }]] }] }],
  ["image_url array instead of object", { messages: [{ content: [{ type: "image_url", image_url: [{ url: syntheticUrl("png") }] }] }] }],
]) {
  assert.deepEqual(plain(prepareSecurityScanBody(body)), body, name);
  assert.equal(projectedScan(body).suspicious, true, name); checks.push(`${name} receives no exemption`);
}
for (const type of [undefined, "image", "IMAGE_URL", "image_url "]) {
  const body = inline(); if (type === undefined) delete body.messages[0].content[0].type; else body.messages[0].content[0].type = type;
  assert.deepEqual(plain(prepareSecurityScanBody(body)), body); assert.equal(projectedScan(body).suspicious, true);
  checks.push(`nonexact image discriminator ${String(type)} receives no exemption`);
}
const url = syntheticUrl("png");
for (const [label, value] of [
  ["remote URL", `https://example.invalid/${hit}/image.png`],
  ["MIME gif", url.replace("image/png", "image/gif")],
  ["MIME text/html", url.replace("image/png", "text/html")],
  ["uppercase MIME", url.replace("image/png", "image/PNG")],
  ["additional header parameter", url.replace(";base64,", ";name=example;base64,")],
  ["leading whitespace", ` ${url}`],
  ["payload whitespace", `${url.slice(0, -4)}\nAAAA`],
  ["URL-safe alphabet", `${url.slice(0, -4)}AA_A`],
  ["invalid character", `${url.slice(0, -4)}AA%A`],
  ["incorrect length", `${url}A`],
  ["internal padding", `${url.slice(0, -4)}=AAA`],
  ["too much padding", `${url.slice(0, -4)}A===`],
  ["noncanonical double-pad tail bits", `${url.slice(0, -4)}AB==`],
  ["noncanonical single-pad tail bits", `${url.slice(0, -4)}AAB=`],
  ["signature/MIME mismatch", syntheticUrl("jpeg").replace("image/jpeg", "image/png")],
  ["missing image signature", `data:image/png;base64,${Buffer.alloc(24).toString("base64")}${hit}AAAA`],
  ["empty payload", "data:image/png;base64,"],
]) expectFallback(value, `${label} retains ordinary string scanning`);
expectOpaque(`${url.slice(0, -4)}AA==`, "canonical two-padding tail remains opaque");
expectOpaque(`${url.slice(0, -4)}AAA=`, "canonical one-padding tail remains opaque");

const many = { messages: [{ role: "user", content: Array.from({ length: 17 }, () => ({ type: "image_url", image_url: { url } })) }] };
const manyProjected = prepareSecurityScanBody(many);
assert.equal(manyProjected.messages[0].content.filter(part => part.image_url.url === sentinel).length, 16);
assert.equal(manyProjected.messages[0].content[16].image_url.url, url);
assert.equal(security.detectSuspiciousBody(manyProjected).suspicious, true);
checks.push("the seventeenth image retains ordinary scanning instead of expanding the 16-image exemption cap");
const largeUrl = (encodedLength, fill = "G") => {
  assert.equal(encodedLength % 4, 0);
  const start = url.slice("data:image/png;base64,".length, -4);
  return `data:image/png;base64,${start}${fill.repeat(encodedLength - start.length)}`;
};
expectFallback(largeUrl(32 * 1024 * 1024), "over-limit individual URL retains ordinary scanning");
const medium = largeUrl(17 * 1024 * 1024);
const aggregate = { messages: [{ content: [{ type: "image_url", image_url: { url: medium } }, { type: "image_url", image_url: { url: medium } }] }] };
const aggregateProjected = prepareSecurityScanBody(aggregate);
assert.equal(aggregateProjected.messages[0].content[0].image_url.url, sentinel);
assert.equal(aggregateProjected.messages[0].content[1].image_url.url, medium);
assert.equal(security.detectSuspiciousBody(aggregateProjected).suspicious, true);
checks.push("aggregate 32 MiB code-unit budget exempts the first valid image and leaves the next image fully scannable");
// A very long hexadecimal-looking tail exposes an existing unbounded global
// regex behavior. Preserve and disclose parity; do not silently claim the
// scan-only projection repairs or safely accepts that unrelated detector edge.
const legacyHexBody = inline(largeUrl(32 * 1024 * 1024, "A"));
const detectorOutcome = body => {
  try { const result = security.detectSuspiciousBody(body); return { kind: "result", suspicious: result.suspicious, threatType: result.threatType }; }
  catch (error) { assert.equal(error?.name, "RangeError"); return { kind: "error", name: error.name }; }
};
const legacyOutcome = detectorOutcome(legacyHexBody);
assert.deepEqual(detectorOutcome(prepareSecurityScanBody(legacyHexBody)), legacyOutcome);
checks.push("oversize long-hex legacy detector behavior is identical before/after projection; this patch does not claim to fix that existing regex complexity edge");

const skipped = { ...inline(), agentName: hit, metadata: { nested: { exempt: hit, retained: "safe" } } };
const skippedBefore = JSON.stringify(skipped);
assert.equal(projectedScan(skipped).suspicious, true);
assert.equal(projectedScan(skipped, ["agentName", " metadata . nested . exempt "]).suspicious, false);
assert.equal(JSON.stringify(skipped), skippedBefore);
skipped.metadata.nested.retained = '<script>alert(1)</script>';
assert.equal(projectedScan(skipped, ["agentName", "metadata.nested.exempt"]).suspicious, true);
const nestedText = inline(); nestedText.messages[0].content.push({ type: "text", text: hit });
assert.equal(projectedScan(nestedText, ["messages.0.content.1.text"]).suspicious, false);
assert.equal(prepareSecurityScanBody(nestedText, ["messages"]).messages, undefined);
checks.push("existing deep and dotted-array skipFields exemptions remove only explicit fields, preserve every sibling scan, and never mutate input");
for (const [fields, attacked] of [[ ["agentName", "botId"], "agentName" ], [ ["task_label", "batch_topic"], "batch_topic" ]]) {
  assert.equal(security.detectSuspiciousBody({ [attacked]: hit, messages: [] }, fields).suspicious, true);
  assert.equal(security.detectSuspiciousBody({ prompt: hit, [attacked]: "safe" }, fields).suspicious, false);
}
checks.push("shared chat/video selective metadata consumers keep their original detector semantics");

const request = new Request("http://127.0.0.1:5000/api/llm", { method: "POST", headers: { "x-real-ip": "127.0.0.1" } });
const user = { userId: "fixture-user" };
const callsBefore = detectorInputs.length;
assert.equal(await checkBodyInjection(actual, request, [], user.userId, user), null);
assert.equal(detectorInputs.length, callsBefore + 1);
assert.equal(detectorInputs.at(-1).messages[1].content[2].image_url.url, sentinel);
assert.equal(hash(JSON.stringify(actual)), actualBefore);
const dangerous = inline(); dangerous.messages[0].content[0].image_url.detail = '<script>alert(1)</script>';
const blocked = await checkBodyInjection(dangerous, request, [], user.userId, user);
assert.equal(blocked.status, 400); assert.equal((await blocked.json()).code, "SUSPICIOUS_BODY");
assert.equal(await checkBodyInjection(skipped, request, ["agentName", "metadata"], user.userId, user), null);
assert.equal(await runSecurityChecks(actual, request, { userId: user.userId, preVerifiedUser: user }), null);
await Promise.resolve();
assert.ok(logEvents.some(event => event.event_type === "xss_attempt" && event.blocked));
checks.push("actual full checkBodyInjection and runSecurityChecks feed the projected body to the real detector; suspicious sibling still returns HTTP 400 while logging persistence is isolated");

assert.equal(hash(securitySource), diagnosis.sourceHashes[securityPath], "The global detector and its SQL regex must remain unchanged");
assert.equal(hash(readFileSync(path.join(root, "src/app/api/llm/route.ts"))), diagnosis.sourceHashes["src/app/api/llm/route.ts"], "The LLM route must remain unchanged");
assert.equal(readFileSync(path.join(root, securityPath), "utf8"), securitySource, "Security source changed during this run");
assert.equal(readFileSync(path.join(root, llmPath), "utf8"), llmSource, "LLM scan projection changed during this run");
assert.equal(externalCalls, 0); assert.equal(authCalls, 0);
console.log(JSON.stringify({ passed: true, checks: checks.length, networkCalls: externalCalls, providerCalls: 0, liveDatabaseCalls: 0, secretReads: 0,
  sourceHashes: { [securityPath]: hash(securitySource), [llmPath]: hash(llmSource) }, actualImageSha256: hash(png),
  timerRegistrationsIsolated: timerRegistrations, logPersistenceSubstituted: true,
  existingOversizeHexDetectorOutcome: legacyOutcome,
  evidence: "Both complete real TypeScript modules compiled and executed in a VM. Actual detectors, projection and check handlers run. Only auth/DB logging/timer/external I/O ports are isolated; no provider, live DB, secret or network use.", cases: checks }, null, 2));
