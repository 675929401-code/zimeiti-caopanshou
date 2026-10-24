import assert from "node:assert/strict";
import {
  chooseStoryboardAttempt, groupStoryboardSegments, matchesStoryboardRecord,
  normalizeStoryboardHistoryCardIndex, statsStoryboardRecords, storyboardRecordState,
  storyboardSegmentKey, versionNumber, type StoryboardHistoryRecord,
} from "../src/lib/storyboard-history-view";

let checks = 0;
function check(name: string, test: () => void) {
  test();
  checks += 1;
  console.log(`PASS ${name}`);
}

function record(taskId: string, cardIndex: number | undefined, minute: number, patch: Partial<StoryboardHistoryRecord> = {}): StoryboardHistoryRecord {
  return { taskId, cardIndex, batchId: "batch-a", status: "completed", createdAt: `2026-10-23T01:${String(minute).padStart(2, "0")}:00Z`, ...patch };
}

const items = [
  record("seg1-v1", 0, 1), record("seg2-v1", 1, 2), record("seg2-v2", 1, 3),
  record("seg3-v1", 2, 4), record("seg3-v2", 2, 5, { status: "failed" }),
  record("seg4-v1", 3, 6), record("seg5-v1", 4, 7), record("seg6-v1", 5, 8), record("seg7-v1", 6, 9),
];

check("seven logical segments retain nine generation attempts and stable version numbers", () => {
  const segments = groupStoryboardSegments([...items].reverse());
  assert.equal(segments.length, 7);
  assert.equal(segments.reduce((sum, segment) => sum + segment.attempts.length, 0), 9);
  assert.deepEqual(segments.map((segment) => segment.cardIndex), [0, 1, 2, 3, 4, 5, 6]);
  assert.deepEqual(segments[1].attempts.map((item) => item.taskId), ["seg2-v1", "seg2-v2"]);
  assert.equal(versionNumber(segments[1], "seg2-v2"), 2);
  assert.equal(versionNumber(segments[1], "missing"), undefined);
  assert.deepEqual(statsStoryboardRecords(items), { all: 9, playable: 8, active: 0, unavailable: 0, failed: 1 });
});

check("unknown indexes never merge and batch boundaries prevent cross-batch grouping", () => {
  const segments = groupStoryboardSegments([
    record("a", 0, 1), record("b", 0, 2, { batchId: "batch-b" }),
    record("c", undefined, 3), record("d", -1, 4), record("e", 1.5, 5),
  ]);
  assert.equal(segments.length, 5);
  assert.equal(new Set(segments.map((segment) => segment.key)).size, 5);
  assert.deepEqual(segments.map((segment) => segment.cardIndex), [0, 0, undefined, undefined, undefined]);
  assert.equal(storyboardSegmentKey(record("c", undefined, 3)), "task:c");
  assert.equal(storyboardSegmentKey(record("a", 0, 1)), "segment:0");
});

check("latest active and failed attempts remain visible without hiding older playable versions", () => {
  for (const status of ["queued", "pending", "processing", "generating", "finalizing", "billing_pending"]) {
    const segment = groupStoryboardSegments([record("old", 0, 1), record("new", 0, 2, { status })])[0];
    assert.equal(chooseStoryboardAttempt(segment, "all")?.taskId, "new");
    assert.equal(chooseStoryboardAttempt(segment, "active")?.taskId, "new");
    assert.equal(chooseStoryboardAttempt(segment, "playable")?.taskId, "old");
  }
  const segment = groupStoryboardSegments(items)[2];
  assert.equal(chooseStoryboardAttempt(segment, "all")?.taskId, "seg3-v2");
  assert.equal(chooseStoryboardAttempt(segment, "failed")?.taskId, "seg3-v2");
  assert.equal(chooseStoryboardAttempt(segment, "playable")?.taskId, "seg3-v1");
  assert.equal(chooseStoryboardAttempt(segment, "active"), undefined);
});

check("billing protection takes precedence over completed or failed media state", () => {
  for (const billingState of ["usage_pending", "quote_exceeded", "billing_review", "settled_pending_commit", "unknown_future_billing", ""]) {
    for (const status of ["completed", "failed"]) {
      const item = record("protected", 0, 1, { billingState, status });
      assert.equal(storyboardRecordState(item, true), "active");
      assert.equal(matchesStoryboardRecord(item, "playable", true), false);
      assert.equal(matchesStoryboardRecord(item, "all"), true);
    }
  }
});

check("unknown task states stay protected while only settled terminal failures become failed", () => {
  for (const status of ["unknown", "provider_confirming", "", "future_state"]) {
    assert.equal(storyboardRecordState(record("unknown", 0, 1, { status, billingState: "settled" })), "active");
    assert.equal(storyboardRecordState(record("unknown", 0, 1, { status })), "active");
  }
  for (const billingState of ["settled", "not_required", "exempt", "failed", "cancelled", "submission_failed", "refunded", "not_charged"]) {
    assert.equal(storyboardRecordState(record("ended", 0, 1, { status: "failed", billingState })), "failed");
  }
  assert.deepEqual(statsStoryboardRecords([
    record("review", 0, 1, { status: "failed", billingState: "billing_review" }),
    record("commit", 1, 1, { status: "completed", billingState: "settled_pending_commit" }),
    record("failed", 2, 1, { status: "failed", billingState: "settled" }),
  ]), { all: 3, playable: 0, active: 2, unavailable: 0, failed: 1 });
});

check("expired remote media is unavailable while a valid local result remains playable", () => {
  const expired = record("expired", 0, 1, { deliveryState: "expired", mediaAvailable: true });
  assert.equal(storyboardRecordState(expired), "unavailable");
  assert.equal(storyboardRecordState(expired, true), "playable");
  assert.equal(storyboardRecordState(record("missing", 0, 1, { mediaAvailable: false })), "unavailable");
  assert.equal(storyboardRecordState(record("missing", 0, 1, { mediaAvailable: false }), true), "playable");
  assert.equal(storyboardRecordState(record("legacy", 0, 1)), "playable");
  assert.deepEqual(statsStoryboardRecords([expired], () => true), { all: 1, playable: 1, active: 0, unavailable: 0, failed: 0 });
});

check("explicit matching selection survives polling and falls back when no longer eligible", () => {
  const before = groupStoryboardSegments(items)[1];
  assert.equal(chooseStoryboardAttempt(before, "all", "seg2-v1")?.taskId, "seg2-v1");
  const polled = groupStoryboardSegments([...items, record("seg2-v3", 1, 10)])[1];
  assert.equal(chooseStoryboardAttempt(polled, "all", "seg2-v1")?.taskId, "seg2-v1");
  assert.equal(chooseStoryboardAttempt(polled, "all", "removed")?.taskId, "seg2-v3");
  const changed = groupStoryboardSegments([...items, record("seg2-v1", 1, 2, { mediaAvailable: false })])[1];
  assert.equal(chooseStoryboardAttempt(changed, "playable", "seg2-v1")?.taskId, "seg2-v2");
  assert.equal(chooseStoryboardAttempt(changed, "unavailable", "seg2-v1")?.taskId, "seg2-v1");
  assert.equal(chooseStoryboardAttempt(changed, "playable", "seg2-v1", (item) => item.taskId === "seg2-v1")?.taskId, "seg2-v1");
});

check("duplicate snapshots count once and deterministic task IDs break timestamp ties", () => {
  const a = record("a", 0, 1);
  const z = record("z", 0, 1);
  const updated = { ...a, status: "processing" };
  const segment = groupStoryboardSegments([z, a, updated])[0];
  assert.deepEqual(segment.attempts.map((item) => item.taskId), ["a", "z"]);
  assert.equal(segment.attempts[0], updated);
  assert.deepEqual(statsStoryboardRecords([z, a, updated]), { all: 2, playable: 1, active: 1, unavailable: 0, failed: 0 });
});

check("history boundary converts positive integer indexes only", () => {
  assert.equal(normalizeStoryboardHistoryCardIndex(1), 0);
  assert.equal(normalizeStoryboardHistoryCardIndex(8), 7);
  for (const value of [0, -1, 1.5, NaN, Infinity, "2", null, undefined]) {
    assert.equal(normalizeStoryboardHistoryCardIndex(value), undefined);
  }
});

check("grouping, filtering and statistics never mutate input arrays or records", () => {
  const frozen = Object.freeze(items.map((item) => Object.freeze({ ...item })));
  const original = JSON.stringify(frozen);
  const segments = groupStoryboardSegments(frozen);
  statsStoryboardRecords(frozen);
  for (const segment of segments) chooseStoryboardAttempt(segment, "playable");
  assert.equal(JSON.stringify(frozen), original);
});

console.log(JSON.stringify({ passed: true, checks, networkRequests: 0, databaseWrites: 0, generationRequests: 0 }));
