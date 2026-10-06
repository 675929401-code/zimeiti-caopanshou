import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  isBlockedIpAddress,
  SafeFetchError,
  validateSafeUrl,
} from "../src/lib/safe-fetch";
import {
  UploadValidationError,
  validateUploadBuffer,
} from "../src/lib/file-upload-security";
import {
  getServerSecret,
  requireServerSecret,
  safeCompareSecret,
} from "../src/lib/server-secrets";
import { LocalProvider, resolvePathWithinRoot } from "../src/storage/object/providers/local";

type Test = { name: string; run: () => void | Promise<void> };

const tests: Test[] = [];
const test = (name: string, run: Test["run"]) => tests.push({ name, run });
const source = (relativePath: string) => readFileSync(resolve(process.cwd(), relativePath), "utf8");

test("production runtime never accepts a development secret fallback", () => {
  const previousNodeEnv = process.env.NODE_ENV;
  const variableName = "P0_RELEASE_MISSING_VALUE";
  const previousValue = process.env[variableName];
  try {
    Reflect.set(process.env, "NODE_ENV", "production");
    Reflect.deleteProperty(process.env, variableName);
    assert.equal(getServerSecret(variableName, "development-only"), null);
    assert.throws(() => requireServerSecret(variableName, "development-only"), /required in production/u);
    assert.equal(safeCompareSecret("same-value", "same-value"), true);
    assert.equal(safeCompareSecret("same-value", "different-value"), false);
  } finally {
    if (previousNodeEnv === undefined) Reflect.deleteProperty(process.env, "NODE_ENV");
    else Reflect.set(process.env, "NODE_ENV", previousNodeEnv);
    if (previousValue === undefined) Reflect.deleteProperty(process.env, variableName);
    else Reflect.set(process.env, variableName, previousValue);
  }
});

test("SSRF guard blocks private and loopback targets", async () => {
  for (const address of [
    "127.0.0.1",
    "10.0.0.1",
    "169.254.169.254",
    "172.16.0.1",
    "192.168.1.1",
    "::1",
    "fc00::1",
    "::ffff:127.0.0.1",
  ]) {
    assert.equal(isBlockedIpAddress(address), true, address);
  }
  const credentialUrl = ["https://user", "password@example.com/"].join(":");
  await assert.rejects(
    () => validateSafeUrl(credentialUrl),
    (error: unknown) => error instanceof SafeFetchError && error.code === "URL_CREDENTIALS_FORBIDDEN",
  );
});

test("upload validation rejects active content and mismatched signatures", () => {
  assert.throws(
    () => validateUploadBuffer(Buffer.from("<svg onload=\"alert(1)\"></svg>"), "image/svg+xml"),
    (error: unknown) => error instanceof UploadValidationError && error.code === "ACTIVE_CONTENT_FORBIDDEN",
  );
  assert.throws(
    () => validateUploadBuffer(Buffer.from("not-a-jpeg"), "image/jpeg"),
    (error: unknown) => error instanceof UploadValidationError && error.code === "FILE_SIGNATURE_MISMATCH",
  );
  const pngHeader = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
  assert.equal(validateUploadBuffer(pngHeader, "image/png").contentType, "image/png");
});

test("local public storage validates bytes and commits only a safe extension", async () => {
  const directory = await mkdtemp(join(tmpdir(), "local-provider-p0-"));
  const provider = new LocalProvider();
  try {
    await provider.initialize({ basePath: directory });
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
    const result = await provider.upload(png, "unsafe.html", "image/png", { category: "image" });
    assert.match(result.key, /[.]png$/u);
    assert.equal(result.contentType, "image/png");
    assert.deepEqual(await readFile(resolvePathWithinRoot(directory, result.key)), png);
    await assert.rejects(
      () => provider.upload(Buffer.from("<svg onload='alert(1)'></svg>"), "picture.png", "image/svg+xml", { category: "image" }),
      (error: unknown) => error instanceof UploadValidationError && error.code === "ACTIVE_CONTENT_FORBIDDEN",
    );
  } finally {
    await provider.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});

test("development session is inaccessible in production and off loopback", () => {
  const route = source("src/app/api/auth/dev-session/route.ts");
  assert.match(route, /process\.env\.NODE_ENV === "production"/u);
  assert.match(route, /!isLoopback/u);
  assert.match(route, /x-local-workbench/u);
  assert.match(route, /status: 404/u);
});

test("registration uses an atomic invitation transaction", () => {
  const route = source("src/app/api/auth/register/route.ts");
  assert.match(route, /register_invited_user_atomic/u);
  assert.match(route, /hashPassword\(password\)/u);
  assert.match(route, /PGRST202/u);
  assert.match(route, /status: 503/u);
});

test("LLM route requires server-side idempotency before model submission", () => {
  const route = source("src/app/api/llm/route.ts");
  const claimIndex = route.indexOf("await llmRequestAttemptStore.claim");
  const providerStartIndex = route.indexOf("await llmRequestAttemptStore.markProviderCallStarted");
  const submitIndex = route.indexOf("handleStreamResponse(streamCtx");
  assert.ok(claimIndex > 0);
  assert.ok(providerStartIndex > claimIndex);
  assert.ok(submitIndex > 0);
  assert.match(route, /LLM_IDEMPOTENCY_KEY_REQUIRED/u);
  assert.match(route, /LLM_IDEMPOTENCY_STORE_UNAVAILABLE/u);
  assert.ok(claimIndex < submitIndex);
  assert.ok(providerStartIndex < submitIndex);
  assert.match(route, /completeLlmAttemptResponse/u);
});

test("deep-thinking failure cannot silently submit a paid fallback", () => {
  const route = source("src/app/api/llm/handle-deep-thinking.ts");
  assert.match(route, /DEEP_THINKING_FAILED/u);
  assert.match(route, /automatic paid fallback is disabled/u);
  assert.doesNotMatch(route, /falling back to normal mode/u);
});

test("conversation history enforces ownership on writes and deletes", () => {
  const route = source("src/app/api/conversations/history/route.ts");
  assert.match(route, /ensureConversationOwnership/u);
  assert.match(route, /ConversationNotFoundError/u);
  assert.match(route, /\.eq\("conversation_id",\s*id\)\.eq\("user_id",\s*userId\)/u);
  assert.match(route, /\.eq\("id",\s*id\)\.eq\("user_id",\s*userId\)/u);
});

test("legacy public disaster-recovery bootstrap is permanently disabled", () => {
  const route = source("src/app/api/restore/bootstrap/route.ts");
  assert.match(route, /LEGACY_RESTORE_DISABLED/u);
  assert.match(route, /status:\s*404/u);
  assert.match(route, /Cache-Control["']?:\s*["']no-store/u);
  assert.doesNotMatch(route, /restore_token|PRIVATE KEY|\.env\.local|StrictHostKeyChecking|ssh-keyscan|rsync|scp\s/u);
  assert.doesNotMatch(route, /(?:username|password)\s*=/u);
});

async function main(): Promise<void> {
  let passed = 0;
  for (const item of tests) {
    await item.run();
    passed += 1;
    console.log(`PASS ${item.name}`);
  }
  console.log(`Release security P0: ${passed}/${tests.length} tests passed without external network calls.`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
