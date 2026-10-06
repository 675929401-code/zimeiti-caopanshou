import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import { resolveProviderSecret } from "../src/lib/provider-secret";

type Probe = {
  label: string;
  endpoint: string;
  credential: string;
  modelName: string;
};

const probes: Probe[] = [
  {
    label: "gaorui-grok-imagine-1-0-video",
    endpoint: "https://gaorui.cc/v1/models",
    credential: "secret://gaorui-grok-imagine-1-0-video",
    modelName: "grok-imagine-1.0-video",
  },
  {
    label: "gaorui-grok-imagine-video-1-5",
    endpoint: "https://gaorui.cc/v1/models",
    credential: "secret://gaorui-grok-imagine-video-1-5",
    modelName: "grok-imagine-video-1.5",
  },
  {
    label: "secure-skill-grok-video-backup",
    endpoint: "https://token.secure-skill.com/v1/models",
    credential: "secret://secure-skill-grok-video-backup",
    modelName: "grok-imagine-video",
  },
];

function collectModelIds(value: unknown): string[] {
  if (!value || typeof value !== "object") return [];
  const record = value as Record<string, unknown>;
  const candidates = Array.isArray(record.data)
    ? record.data
    : Array.isArray(record.models)
      ? record.models
      : [];
  return candidates
    .map((item) => item && typeof item === "object" ? String((item as Record<string, unknown>).id || (item as Record<string, unknown>).name || "") : "")
    .filter(Boolean);
}

async function main() {
  const results = [];
  for (const probe of probes) {
    const key = resolveProviderSecret(probe.credential);
    const startedAt = Date.now();
    const response = await fetch(probe.endpoint, {
      method: "GET",
      headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    });
    const body = await response.text();
    const parsed = (() => { try { return JSON.parse(body) as unknown; } catch { return null; } })();
    const ids = collectModelIds(parsed);
    const targetListed = ids.includes(probe.modelName);
    results.push({
      label: probe.label,
      status: response.status,
      authenticated: response.ok,
      targetListed,
      modelCount: ids.length,
      latencyMs: Date.now() - startedAt,
      responseSha256: createHash("sha256").update(body).digest("hex"),
    });
    assert.equal(response.ok, true, `${probe.label} catalog authentication failed with HTTP ${response.status}`);
    assert.equal(targetListed, true, `${probe.label} catalog does not list ${probe.modelName}`);
  }
  console.log(JSON.stringify({
    passed: true,
    providerRequests: probes.length,
    paidGenerationCalls: 0,
    secretValuesPrinted: false,
    results,
  }, null, 2));
}

void main().catch((error) => {
  console.error(JSON.stringify({
    passed: false,
    message: error instanceof Error ? error.message : "PROVIDER_AUTH_PROBE_FAILED",
    providerRequests: probes.length,
    paidGenerationCalls: 0,
    secretValuesPrinted: false,
  }));
  process.exitCode = 1;
});
