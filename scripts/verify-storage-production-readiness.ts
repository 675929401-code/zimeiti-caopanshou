/**
 * Production object-storage gate.
 *
 * Read-only: loads the production provider configuration and performs a
 * one-item list request. It never uploads, deletes, or prints credentials or
 * object keys.
 */
import assert from "node:assert/strict";

async function main(): Promise<void> {
  Object.assign(process.env, { NODE_ENV: "production" });

  const startedAt = Date.now();
  const { storageManager } = await import("../src/storage/object");
  const status = await storageManager.getStatus();

  assert.equal(
    status.productionSafe,
    true,
    `Object storage is not production-safe: ${status.issues.join("; ")}`
  );
  assert.notEqual(status.defaultProvider, "local", "Production default provider must not be local");
  assert.equal(
    status.initializedProviders.includes(status.defaultProvider),
    true,
    `Default provider ${status.defaultProvider} was not initialized`
  );
  assert.equal(
    status.initializedProviders.includes("local"),
    false,
    "Production runtime silently initialized local storage"
  );

  let timeout: ReturnType<typeof setTimeout> | undefined;
  const listResult = await Promise.race([
    storageManager.list({ maxKeys: 1 }, status.defaultProvider),
    new Promise<never>((_, reject) => {
      timeout = setTimeout(() => reject(new Error("Object storage read probe timed out")), 8_000);
    }),
  ]).finally(() => {
    if (timeout) clearTimeout(timeout);
  });

  console.log(
    JSON.stringify(
      {
        ok: true,
        runtimeMode: status.runtimeMode,
        defaultProvider: status.defaultProvider,
        fallbackProvider: status.fallbackProvider,
        initializedProviders: status.initializedProviders,
        productionSafe: status.productionSafe,
        readProbe: {
          ok: true,
          returnedItems: listResult.items.length,
          hasMore: listResult.hasMore,
        },
        latencyMs: Date.now() - startedAt,
      },
      null,
      2
    )
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
