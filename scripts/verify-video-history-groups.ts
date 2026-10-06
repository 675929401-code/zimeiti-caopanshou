import assert from "node:assert/strict";
import { groupVideoHistory } from "../src/lib/video-history-groups";

const items = Object.freeze([
  Object.freeze({ id: "recent-single", createdAt: "2026-09-05T10:00:00Z" }),
  Object.freeze({ id: "shot-2", batchId: "older-batch", createdAt: "2026-09-05T09:00:00Z", cardIndex: 2 }),
  Object.freeze({ id: "old-single", createdAt: "2026-09-04T10:00:00Z" }),
  Object.freeze({ id: "shot-1", batchId: "older-batch", createdAt: "2026-09-05T08:00:00Z", cardIndex: 1 }),
]);
const result = groupVideoHistory(items);
assert.deepEqual(result.map(group => group.key), ["task:recent-single", "batch:older-batch", "task:old-single"]);
assert.deepEqual(result[1].items.map(item => item.id), ["shot-1", "shot-2"]);
assert.deepEqual(items.map(item => item.id), ["recent-single", "shot-2", "old-single", "shot-1"]);
assert.deepEqual(groupVideoHistory([...items].reverse()).map(group => group.key), result.map(group => group.key));
const collisions = groupVideoHistory([
  { id: "shared", createdAt: "2026-09-05T10:00:00Z" },
  { id: "shot", batchId: "shared", createdAt: "2026-09-04T10:00:00Z" },
  { id: "invalid", createdAt: "invalid" },
]);
assert.equal(new Set(collisions.map(group => group.key)).size, 3);
assert.equal(collisions.at(-1)?.label, "时间未记录");
const years = groupVideoHistory([
  { id: "new", batchId: "new-year", createdAt: "2026-09-05T08:00:00Z" },
  { id: "old", batchId: "old-year", createdAt: "2025-09-05T08:00:00Z" },
]);
assert.ok(years.every(group => group.label.includes("第1批")));
assert.deepEqual(groupVideoHistory([]), []);
console.log(JSON.stringify({ status: "PASS", newestFirstAcrossBatchAndSingle: true, shotOrderPreserved: true, inputUnchanged: true, duplicateKeysAndInvalidDatesHandled: true }));
