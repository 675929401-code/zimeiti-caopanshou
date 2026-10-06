import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createDatabaseFetch } from "../src/storage/database/database-transport";

async function main() {
  const counts = new Map<string, number>();
  const bodies = new Map<string, string[]>();
  const server = createServer(async (request, response) => {
    const key = request.url || "/";
    const count = (counts.get(key) || 0) + 1;
    counts.set(key, count);
    let body = "";
    for await (const chunk of request) body += chunk;
    bodies.set(key, [...(bodies.get(key) || []), body]);
    if (key.includes("http-status")) {
      response.writeHead(503); response.end("temporarily unavailable"); return;
    }
    if (count === 1 || key.includes("always-drop")) {
      request.socket.destroy(); return;
    }
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({ success: true }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const origin = `http://127.0.0.1:${address.port}`;
  const transport = createDatabaseFetch(origin);
  const checks: string[] = [];
  try {
    for (const method of ["GET", "HEAD"]) {
      const key = `/rest/v1/catalog?${method}`;
      const response = await transport(new Request(origin + key, { method }));
      assert.equal(response.status, 200);
      assert.equal(counts.get(key), 2);
      checks.push(`${method}: real dropped socket recovered once`);
    }
    const recovery = "/rest/v1/rpc/recover_llm_credit_reservations_atomic";
    const payload = JSON.stringify({ p_user_id: "local-fixture" });
    assert.equal((await transport(origin + recovery, { method: "POST", body: payload })).status, 200);
    assert.deepEqual(bodies.get(recovery), [payload, payload]);
    checks.push("atomic recovery: identical replayable payload after dropped socket");

    for (const [method, key] of [
      ["POST", "/rest/v1/rpc/charge_cash_atomic"],
      ["POST", "/rest/v1/tasks"], ["PATCH", "/rest/v1/users"],
      ["DELETE", "/rest/v1/media"], ["GET", "/rest/v1/rpc/unclassified_function"],
      ["GET", "/storage/v1/object"],
    ]) {
      await assert.rejects(transport(origin + key, { method }));
      assert.equal(counts.get(key), 1, `${method} ${key} must not replay`);
    }
    checks.push("writes, unclassified RPC and storage: zero retries");
    const streamedRecovery = `${recovery}?request-body`;
    await assert.rejects(transport(new Request(origin + streamedRecovery, { method: "POST", body: payload })));
    assert.equal(counts.get(streamedRecovery), 1);
    checks.push("Request POST without buffered init body is never retried");
    const always = "/rest/v1/catalog?always-drop";
    await assert.rejects(transport(origin + always));
    assert.equal(counts.get(always), 2);
    checks.push("persistent socket failure: exactly two attempts then error");
    const status = "/rest/v1/catalog?http-status";
    assert.equal((await transport(origin + status)).status, 503);
    assert.equal(counts.get(status), 1);
    checks.push("HTTP errors are returned unchanged without retry");
    const external = "/rest/v1/catalog?different-configured-origin";
    await assert.rejects(createDatabaseFetch("http://127.0.0.1:1")(origin + external));
    assert.equal(counts.get(external), 1);
    checks.push("other origin cannot inherit database retry permission");
    let attempts = 0;
    const socketError = new TypeError("fetch failed", { cause: Object.assign(new Error("reset"), { code: "ECONNRESET" }) });
    const controller = new AbortController();
    const aborting = createDatabaseFetch(origin, (async () => {
      attempts++; setTimeout(() => controller.abort(), 20); throw socketError;
    }) as typeof fetch);
    await assert.rejects(aborting(origin + "/rest/v1/catalog", { signal: controller.signal }), { name: "AbortError" });
    assert.equal(attempts, 1);
    checks.push("abort during backoff prevents second request");
    attempts = 0;
    const programmingError = new TypeError("invalid request configuration");
    await assert.rejects(createDatabaseFetch(origin, (async () => { attempts++; throw programmingError; }) as typeof fetch)(origin + "/rest/v1/catalog"), error => error === programmingError);
    assert.equal(attempts, 1);
    checks.push("application errors are not misclassified as network retries");
    console.log(JSON.stringify({ passed: true, checks }, null, 2));
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
