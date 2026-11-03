import "server-only";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { validateSnapshot } from "./published-configuration-public.mjs";

// Public anonymous projections only. This is separate from prompt backups,
// application databases, the source tree and production shared directories.
export const PUBLISHED_SNAPSHOT_DIRECTORY = "F:/总项目文件/Skill存储系统/运行数据/自媒体操盘手/published-configuration-preview";
const MAX_BYTES = 32 * 1024 * 1024;
const FILE = "last-success.v1.json";
const LOCK = "snapshot-write.lock";

export type PublishedSnapshot = {
  schema: "published-preview.v1"; source: string; audience: "guest"; observedAt: string;
  runtime: Record<string, string>; fingerprint: string; hashes: Record<string, string>;
  evidence: Record<string, unknown>; sections: Record<string, Record<string, unknown>>;
};
export type SnapshotRead = { state: "valid"; snapshot: PublishedSnapshot } | { state: "missing" | "corrupt" };

function errorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error ? String(error.code) : undefined;
}
async function safeDirectory(directory: string, create: boolean) {
  let cursor = path.resolve(directory);
  if (cursor === path.parse(cursor).root) throw new Error("PUBLISHED_SNAPSHOT_ROOT_INVALID");
  for (;;) {
    try {
      const stat = await fs.lstat(cursor);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("PUBLISHED_SNAPSHOT_DIRECTORY_UNSAFE");
    } catch (error) { if (errorCode(error) !== "ENOENT") throw error; }
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  if (create) {
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    await safeDirectory(directory, false);
  }
}
async function checkedRead(file: string, maximum = MAX_BYTES, allowedLinks = 1) {
  const before = await fs.lstat(file);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink < 1 || before.nlink > allowedLinks || before.size > maximum) throw new Error("PUBLISHED_SNAPSHOT_FILE_UNSAFE");
  const handle = await fs.open(file, "r");
  try {
    const opened = await handle.stat();
    if (opened.ino !== before.ino || opened.dev !== before.dev) throw new Error("PUBLISHED_SNAPSHOT_FILE_CHANGED");
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (bytes.length !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs) throw new Error("PUBLISHED_SNAPSHOT_FILE_CHANGED");
    return { bytes, stat: before };
  } finally { await handle.close(); }
}
function alive(pid: number) {
  try { process.kill(pid, 0); return true; } catch (error) { return errorCode(error) !== "ESRCH"; }
}

export function createPublishedSnapshotStore(directory = PUBLISHED_SNAPSHOT_DIRECTORY) {
  const root = path.resolve(directory), file = path.join(root, FILE), lock = path.join(root, LOCK);
  async function read(): Promise<SnapshotRead> {
    for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await safeDirectory(root, false);
      const { bytes } = await checkedRead(file);
      const parsed = JSON.parse(bytes.toString("utf8")) as { schema?: string; snapshot?: unknown };
      if (parsed.schema !== "published-configuration-cache.v1" || Object.keys(parsed).sort().join(",") !== "schema,snapshot") throw new Error("PUBLISHED_SNAPSHOT_ENVELOPE_INVALID");
      return { state: "valid", snapshot: validateSnapshot(parsed.snapshot) as PublishedSnapshot };
    } catch (error) {
      if (error instanceof Error && error.message === "PUBLISHED_SNAPSHOT_FILE_CHANGED" && attempt < 2) continue;
      return { state: errorCode(error) === "ENOENT" ? "missing" : "corrupt" };
    }
    }
    return { state: "corrupt" };
  }
  async function exclusive<T>(operation: () => Promise<T>) {
    await safeDirectory(root, true);
    const deadline = Date.now() + 2_000;
    // Publish a complete owner record atomically. Creating an empty public lock
    // and filling it later would strand refreshes if the process died in between.
    const ownerFile = path.join(root, `.write-owner-${process.pid}-${randomUUID()}.tmp`);
    const owner = await fs.open(ownerFile, "wx", 0o600);
    let identity;
    try {
      await owner.writeFile(JSON.stringify({ pid: process.pid, startedAt: Date.now() }));
      await owner.sync(); identity = await owner.stat();
    } finally { await owner.close(); }
    try {
    for (;;) {
      try { await fs.link(ownerFile, lock); }
      catch (error) {
        if (errorCode(error) !== "EEXIST") throw error;
        // A process can exit between creating and removing its short write lock.
        // Reclaim only a well-formed lock whose recorded local PID no longer exists.
        try {
          const existing = await checkedRead(lock, 1024, 2);
          const prior = JSON.parse(existing.bytes.toString("utf8")) as { pid: number; startedAt: number };
          if (Object.keys(prior).sort().join(",") === "pid,startedAt"
            && Number.isSafeInteger(prior.pid) && prior.pid > 0 && Number.isFinite(prior.startedAt)
            && Date.now() - prior.startedAt > 1_000 && !alive(prior.pid)) {
            const current = await fs.lstat(lock);
            if (current.ino === existing.stat.ino && current.dev === existing.stat.dev && current.mtimeMs === existing.stat.mtimeMs) await fs.unlink(lock);
          }
        } catch (error) { if (errorCode(error) !== "ENOENT") { /* Never steal an unknown lock. */ } }
        if (Date.now() >= deadline) throw new Error("PUBLISHED_SNAPSHOT_WRITE_BUSY");
        await new Promise(resolve => setTimeout(resolve, 10));
        continue;
      }
      try {
        return await operation();
      } finally {
        const current = await fs.lstat(lock);
        if (!current.isFile() || current.isSymbolicLink() || current.ino !== identity.ino || current.dev !== identity.dev) throw new Error("PUBLISHED_SNAPSHOT_LOCK_CHANGED");
        await fs.unlink(lock);
      }
    }
    } finally { await fs.unlink(ownerFile); }
  }
  async function save(value: PublishedSnapshot): Promise<PublishedSnapshot> {
    const snapshot = validateSnapshot(value) as PublishedSnapshot;
    const bytes = Buffer.from(JSON.stringify({ schema: "published-configuration-cache.v1", snapshot }) + "\n");
    if (bytes.length > MAX_BYTES) throw new Error("PUBLISHED_SNAPSHOT_TOO_LARGE");
    return exclusive(async () => {
      const current = await read();
      if (current.state === "valid" && Date.parse(current.snapshot.observedAt) > Date.parse(snapshot.observedAt)) return current.snapshot;
      const temporary = path.join(root, `.snapshot-${randomUUID()}.tmp`);
      const handle = await fs.open(temporary, "wx", 0o600);
      try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
      try {
        await safeDirectory(root, false);
        try {
          const target = await fs.lstat(file);
          if (!target.isFile() || target.isSymbolicLink() || target.nlink !== 1) throw new Error("PUBLISHED_SNAPSHOT_FILE_UNSAFE");
        } catch (error) { if (errorCode(error) !== "ENOENT") throw error; }
        await fs.rename(temporary, file);
      } finally {
        try { await fs.unlink(temporary); } catch (error) { if (errorCode(error) !== "ENOENT") throw error; }
      }
      return snapshot;
    });
  }
  return { read, save };
}
