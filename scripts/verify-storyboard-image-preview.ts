import assert from "node:assert/strict";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { readStoryboardProtectedPreview, StoryboardImagePreviewError } from "../src/lib/storyboard-image-preview";

async function main() {
  const checks: string[] = [];
  const url = "/api/media-history/content?recordId=" + "a".repeat(64);
  const png = Uint8Array.from(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+kVxkAAAAASUVORK5CYII=", "base64"));
  const image = () => new Response(png, { headers: { "Content-Type": "image/png" } });
  let calls = 0;
  const fetcher = (handler: (init: RequestInit | undefined) => Promise<Response> | Response) =>
    (async (_input, init) => { calls++; return handler(init); }) as typeof fetch;
  const expectState = (promise: Promise<unknown>, state: "expired" | "unavailable") => assert.rejects(promise,
    error => error instanceof StoryboardImagePreviewError && error.mediaState === state);
  for (const external of ["blob:fixture", "data:image/png;base64,AAAA", "https://fixture.invalid/api/media-history/content?recordId=x"]) {
    assert.equal(await readStoryboardProtectedPreview(external, { fetcher: fetcher(() => { throw new Error("unexpected transport"); }) }), null);
  }
  assert.equal(calls, 0);
  checks.push("unprotected and ephemeral images retain their existing decoder path without fetching");

  const blob = await readStoryboardProtectedPreview(url, { fetcher: fetcher(init => {
    assert.equal(init?.redirect, "error"); assert.equal(init?.cache, "no-store"); assert.equal(init?.credentials, "same-origin");
    assert.ok(init?.signal); return image();
  }) });
  assert.equal(blob?.type, "image/png"); assert.equal(blob?.size, png.length);
  checks.push("owned preview checks an uncached same-origin response then reuses actual raster magic validation");

  for (const type of ["image/svg+xml", "image/png"]) {
    await expectState(readStoryboardProtectedPreview(url, { fetcher: fetcher(() => new Response(type === "image/png" ? png : "<svg/>",
      { headers: { "Content-Type": type, "X-Media-Fallback": "source-expired" } })) }), "unavailable");
  }
  checks.push("legacy HTTP200 fallback is rejected even with decodable pixels or a raster content-type");
  await expectState(readStoryboardProtectedPreview(url, { fetcher: fetcher(() => Response.json({ error: "temporary" }, { status: 503 })) }), "unavailable");
  await expectState(readStoryboardProtectedPreview(url, { fetcher: fetcher(() => Response.json({ error: "expired" }, { status: 410 })) }), "expired");
  checks.push("temporary503 and confirmed410 have distinct availability states");
  await expectState(readStoryboardProtectedPreview(url, { fetcher: fetcher(() => new Response("<svg/>", { headers: { "Content-Type": "image/svg+xml" } })) }), "unavailable");
  await expectState(readStoryboardProtectedPreview(url, { fetcher: fetcher(() => new Response("not a PNG", { headers: { "Content-Type": "image/png" } })) }), "unavailable");
  checks.push("unsupported or spoofed image bodies never become valid original media");
  await expectState(readStoryboardProtectedPreview(url, { fetcher: fetcher(() => new Response(png,
    { headers: { "Content-Type": "image/png", "Content-Length": String(31 * 1024 * 1024) } })) }), "unavailable");
  checks.push("oversized advertised content is refused before image decoding");

  let aborted = false;
  await expectState(readStoryboardProtectedPreview(url, { timeoutMs: 10, fetcher: fetcher(init => {
    init?.signal?.addEventListener("abort", () => { aborted = true; }, { once: true });
    return new Promise<Response>(() => {});
  }) }), "unavailable");
  assert.equal(aborted, true);
  checks.push("a never-returning handshake releases the caller and cancels transport");
  let cancelled = false;
  await expectState(readStoryboardProtectedPreview(url, { timeoutMs: 10, fetcher: fetcher(() => new Response(new ReadableStream({
    start(controller) { controller.enqueue(png); }, cancel() { cancelled = true; },
  }), { headers: { "Content-Type": "image/png" } })) }), "unavailable");
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(cancelled, true);
  checks.push("a stalled response body is bounded and its reader is cancelled");

  const sourceFiles = ["src/lib/storyboard-image-preview.ts", "src/lib/generated-image-download.ts", "scripts/verify-storyboard-image-preview.ts"]
    .map(file => ({ file, sha256: createHash("sha256").update(readFileSync(file)).digest("hex") }));
  const output = ".codex-evidence/storyboard-delivery-audit-20261023/repair/production-hardening/root";
  mkdirSync(output, { recursive: true });
  writeFileSync(`${output}/preview-tests.json`, JSON.stringify({ passed: true, checks, sourceFiles, realNetworkCalls: 0,
    databaseWrites: 0, providerCalls: 0 }, null, 2));
  console.log(JSON.stringify({ passed: true, checks: checks.length }));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
