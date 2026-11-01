// Verifies that clearing history removes the derived cover files only for the
// cleared tasks, and that invalid/escaping ids are ignored. No network, no DB.
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { removeVideoThumbnailCacheFiles } from "../src/lib/video-thumbnail-cache";

async function main() {
  const root = await mkdtemp(path.join(os.tmpdir(), "video-thumbnail-clear-"));
  try {
    const cleared = ["vt_clear_a", "vt_clear_b"];
    const kept = ["vt_keep", "vt_keep_two"];
    for (const taskId of [...cleared, ...kept]) {
      await writeFile(path.join(root, `${taskId}.jpg`), Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
    }
    // A link must never be followed out of the cache root.
    await symlink(path.join(root, "vt_keep.jpg"), path.join(root, "vt_link.jpg"));

    const removed = await removeVideoThumbnailCacheFiles(root, [...cleared, "../escape", "bad/id", "vt_keep"]);
    assert.equal(removed, 3, "cleared covers plus the explicitly listed keep task are removed, invalid ids are ignored");
    const leftover = (await readdir(root)).sort();
    assert.deepEqual(leftover, ["vt_keep_two.jpg", "vt_link.jpg"], "untouched covers stay, links are skipped");

    const missing = await removeVideoThumbnailCacheFiles(root, ["vt_never_written"]);
    assert.equal(missing, 0, "missing covers are not an error");
    assert.equal(await removeVideoThumbnailCacheFiles(root, []), 0, "empty list is a no-op");

    console.log(JSON.stringify({
      status: "PASS",
      removed,
      leftover,
      note: "clearing history deletes only the derived covers it owns; root escapes and links are refused",
    }));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

void main().catch((error) => { console.error(error); process.exitCode = 1; });
