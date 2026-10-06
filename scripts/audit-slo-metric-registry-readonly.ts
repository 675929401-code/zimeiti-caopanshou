import assert from "node:assert/strict";

import { readSloMetricRegistrySnapshot } from "../src/lib/server/slo-metric-registry";

async function main(): Promise<void> {
  const snapshot = await readSloMetricRegistrySnapshot({
    windowHours: 24,
    historyPoints: 2,
    bypassCache: true,
  });

  assert.equal(snapshot.metrics.length, 41);
  assert.equal(snapshot.summary.registered, 41);
  assert.equal(
    snapshot.summary.available + snapshot.summary.partial + snapshot.summary.unavailable,
    41,
  );
  assert.equal(snapshot.readBudget.providerCalls, 0);
  assert.equal(snapshot.readBudget.businessWrites, 0);

  console.log(JSON.stringify({
    ok: true,
    registryVersion: snapshot.registryVersion,
    asOf: snapshot.asOf,
    metrics: snapshot.summary,
    historyPersistence: snapshot.historyPersistence,
    incidentSlo: snapshot.incidentSlo,
    readBudget: snapshot.readBudget,
    unavailableMetricIds: snapshot.metrics
      .filter((entry) => entry.current.availability === "unavailable")
      .map((entry) => entry.id),
    databaseWrites: 0,
    providerCalls: 0,
  }, null, 2));
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
