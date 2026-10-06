import assert from "node:assert/strict";
import {
  CANVAS_HISTORY_MAX_RECORDS,
  cleanCanvasRunHistory,
} from "../src/lib/canvas-run-history";

const now = Date.UTC(2026, 7, 9, 12, 0, 0);
const day = 24 * 60 * 60 * 1000;
const record = (id: string, ageDays: number) => ({ id, startedAt: new Date(now - ageDays * day).toISOString() });

const defaultRetention = cleanCanvasRunHistory([
  record("today", 0),
  record("two-days", 2),
  record("four-days", 4),
], now);
assert.deepEqual(defaultRetention.map((item) => item.id), ["today", "two-days"]);

const hardLimit = cleanCanvasRunHistory([
  record("four-days", 4),
  record("six-days", 6),
], now, 90);
assert.deepEqual(hardLimit.map((item) => item.id), ["four-days"]);

const capped = cleanCanvasRunHistory(
  Array.from({ length: 12 }, (_, index) => record(`record-${index}`, index / 24)),
  now,
  5,
);
assert.equal(capped.length, CANVAS_HISTORY_MAX_RECORDS);
console.log(`Canvas history verification passed: default=3 days, hard max=5 days, max records=${CANVAS_HISTORY_MAX_RECORDS}.`);
