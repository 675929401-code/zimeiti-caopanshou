import assert from "node:assert/strict";

import {
  deliverSecurityEventWithRetry,
  getSecurityEventProducerConfigurationStatus,
  scheduleSecurityEventDelivery,
  SECURITY_EVENT_DELIVERY_MAX_ATTEMPTS,
  type SecurityEventProducerPayload,
} from "../src/lib/server/security-event-producer";

const payload: SecurityEventProducerPayload = {
  event_type: "unauthorized_access",
  risk_level: "high",
  ip: "203.0.113.8",
  user_agent: "fixture-agent",
  path: "/api/private",
  method: "POST",
  details: "fixture-only",
  blocked: true,
  source: "api_direct",
  user_id: "fixture-user",
};

async function main(): Promise<void> {
const missingConfiguration = getSecurityEventProducerConfigurationStatus(null, "http://127.0.0.1:5000");
assert.deepEqual(missingConfiguration, {
  state: "missing",
  credentialConfigured: false,
  credentialSource: "SECURITY_INTERNAL_KEY",
  failClosed: true,
  receiverOriginConfigured: true,
  maxAttempts: 3,
  requestTimeoutMs: 800,
});

let missingKeyFetches = 0;
const missingKey = await deliverSecurityEventWithRetry(payload, {
  internalKey: null,
  receiverOrigin: "http://127.0.0.1:5000",
  fetchImpl: async () => {
    missingKeyFetches += 1;
    throw new Error("must not be called");
  },
});
assert.equal(missingKey.status, "configuration_missing");
assert.equal(missingKey.attempts, 0);
assert.equal(missingKeyFetches, 0);

const transientAttempts: Array<{ key: string | null; secret: string | null; url: string; body: string }> = [];
const retryDelays: number[] = [];
let transientAttempt = 0;
const recovered = await deliverSecurityEventWithRetry(payload, {
  internalKey: "fixture-dedicated-security-key",
  receiverOrigin: "http://127.0.0.1:5000",
  createIdempotencyKey: () => "edge:fixture-idempotency-key",
  sleep: async (milliseconds) => { retryDelays.push(milliseconds); },
  fetchImpl: async (input, init) => {
    transientAttempt += 1;
    const headers = new Headers(init?.headers);
    transientAttempts.push({
      key: headers.get("idempotency-key"),
      secret: headers.get("x-internal-key"),
      url: String(input),
      body: String(init?.body || ""),
    });
    if (transientAttempt === 1) throw new TypeError("fixture network error must not escape");
    if (transientAttempt === 2) {
      return Response.json({ accepted: false, durable: false }, { status: 503 });
    }
    return Response.json({ accepted: true, durable: true, retryPending: true }, { status: 202 });
  },
});
assert.equal(recovered.status, "delivered");
assert.equal(recovered.attempts, 3);
assert.equal(recovered.durable, true);
assert.deepEqual(retryDelays, [75, 250]);
assert.equal(new Set(transientAttempts.map((attempt) => attempt.key)).size, 1, "retries must reuse one idempotency key");
assert.ok(transientAttempts.every((attempt) => attempt.secret === "fixture-dedicated-security-key"));
assert.ok(transientAttempts.every((attempt) => attempt.url === "http://127.0.0.1:5000/api/admin/security-events/internal"));
assert.ok(transientAttempts.every((attempt) => attempt.body === JSON.stringify(payload)));

let permanentAttempts = 0;
const permanent = await deliverSecurityEventWithRetry(payload, {
  internalKey: "fixture-dedicated-security-key",
  receiverOrigin: "http://127.0.0.1:5000",
  sleep: async () => { throw new Error("permanent rejection must not retry"); },
  fetchImpl: async () => {
    permanentAttempts += 1;
    return Response.json({ accepted: false, durable: false }, { status: 403 });
  },
});
assert.equal(permanent.status, "rejected");
assert.equal(permanentAttempts, 1);

let durableFailureStatusAttempts = 0;
const durableDeadLetter = await deliverSecurityEventWithRetry(payload, {
  internalKey: "fixture-dedicated-security-key",
  receiverOrigin: "http://127.0.0.1:5000",
  fetchImpl: async () => {
    durableFailureStatusAttempts += 1;
    return Response.json({ accepted: true, durable: true, deadLettered: true }, { status: 503 });
  },
});
assert.equal(durableDeadLetter.status, "delivered");
assert.equal(durableDeadLetter.durable, true);
assert.equal(durableFailureStatusAttempts, 1, "a durable receipt must not be duplicated even on HTTP 503");

let exhaustedAttempts = 0;
const exhausted = await deliverSecurityEventWithRetry(payload, {
  internalKey: "fixture-dedicated-security-key",
  receiverOrigin: "http://127.0.0.1:5000",
  sleep: async () => undefined,
  fetchImpl: async () => {
    exhaustedAttempts += 1;
    throw new Error("fixture provider text must not escape");
  },
});
assert.equal(exhausted.status, "retry_exhausted");
assert.equal(exhausted.attempts, SECURITY_EVENT_DELIVERY_MAX_ATTEMPTS);
assert.equal(exhaustedAttempts, SECURITY_EVENT_DELIVERY_MAX_ATTEMPTS);
assert.doesNotMatch(JSON.stringify(exhausted), /fixture provider text/u);

const lifecyclePromises: Promise<unknown>[] = [];
const scheduled = scheduleSecurityEventDelivery(
  { waitUntil: (promise) => { lifecyclePromises.push(promise); } },
  payload,
  {
    internalKey: "fixture-dedicated-security-key",
    receiverOrigin: "http://127.0.0.1:5000",
    fetchImpl: async () => Response.json({ accepted: true, durable: true }, { status: 201 }),
  },
);
assert.equal(scheduled.scheduled, true);
assert.equal(lifecyclePromises.length, 1);
assert.equal((await scheduled.completion)?.durable, true);

console.log(JSON.stringify({
  ok: true,
  schema: "security-event-producer-fault-injection/v1",
  failClosedSecret: true,
  transientRecoveryAttempts: recovered.attempts,
  permanentRejectionAttempts: permanentAttempts,
  durableDeadLetterAttempts: durableFailureStatusAttempts,
  exhaustedAttempts,
  lifecycleWaitUntil: true,
  networkCalls: "fixture-only",
}));
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
