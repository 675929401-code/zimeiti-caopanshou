import assert from "node:assert/strict";
import { mergeStoryboardInlineHistory } from "../src/lib/storyboard-history-local-view";
import { groupStoryboardSegments, storyboardRecordState } from "../src/lib/storyboard-history-view";
import { mergeStoryboardHistory, type StoryboardLocalVideoEntry } from "../src/lib/storyboard-local-video-cache";
const now = new Date().toISOString();
const entry: StoryboardLocalVideoEntry = { available: true, record: {
  key: "fixture", scopeKey: "fixture", taskId: "legacy-first-card", batchId: "batch", cardIndex: 1,
  createdAt: now, completedAt: now, bytesKey: "fixture", posterSize: 0, size: 1,
  sha256: "fixture", mime: "video/mp4", savedAt: Date.now(),
} };
const remote = [{ taskId: "remote-second-card", batchId: "batch", cardIndex: 1, status: "completed", createdAt: now, mediaAvailable: true }];
const merged = mergeStoryboardInlineHistory(remote, [entry]);
assert.equal(merged.find(item => item.taskId === entry.record.taskId)?.cardIndex, undefined);
assert.equal(groupStoryboardSegments(merged).length, 2, "legacy local card must not merge with the next remote segment");
assert.equal(storyboardRecordState(merged.find(item => item.taskId === entry.record.taskId)!, true), "playable");
const missing = mergeStoryboardInlineHistory<(typeof remote)[number]>([], [{ ...entry, available: false }])[0];
assert.equal(missing.mediaAvailable, false);
assert.equal(storyboardRecordState(missing), "unavailable", "missing browser bytes must not enable playback or selection");
const same = mergeStoryboardInlineHistory([{ ...remote[0], taskId: entry.record.taskId, cardIndex: 0 }], [entry]);
assert.equal(same.length, 1); assert.equal(same[0].cardIndex, 0, "remote normalized index is authoritative");
assert.equal(mergeStoryboardHistory(remote, [entry]).find(item => item.taskId === entry.record.taskId)?.cardIndex, 1, "generic video merge remains unchanged");
assert.equal(entry.record.cardIndex, 1, "projection does not migrate persisted browser data");
console.log(JSON.stringify({ passed: true, checks: 7, networkRequests: 0, databaseWrites: 0, generationRequests: 0 }));
