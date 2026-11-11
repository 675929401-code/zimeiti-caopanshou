import { createHash } from "node:crypto";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import path from "node:path";

/** Hash the actual persisted SDK transcript, never rendered response text or a task receipt. */
export async function readNativeAgentSdkCheckpoint(taskDirectory: string, sessionId: string): Promise<string> {
  if (!/^[a-f0-9-]{36}$/iu.test(sessionId)) throw new Error("NATIVE_AGENT_CHECKPOINT_SESSION_INVALID");
  const base = path.resolve(taskDirectory);
  const normalized = (value: string) => process.platform === "win32" ? value.toLowerCase() : value;
  if ((await lstat(base)).isSymbolicLink() || normalized(await realpath(base)) !== normalized(base)) throw new Error("NATIVE_AGENT_CHECKPOINT_DIRECTORY_UNSAFE");
  const found: string[] = [];
  const walk = async (directory: string, depth: number): Promise<void> => {
    if (depth > 8) throw new Error("NATIVE_AGENT_CHECKPOINT_DEPTH_EXCEEDED");
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const filename = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error("NATIVE_AGENT_CHECKPOINT_SYMLINK_DENIED");
      const actual = await realpath(filename);
      const relative = path.relative(base, actual);
      if (!relative || relative.startsWith(".." + path.sep) || path.isAbsolute(relative)) throw new Error("NATIVE_AGENT_CHECKPOINT_PATH_ESCAPE");
      if (entry.isDirectory()) await walk(filename, depth + 1);
      else if (entry.isFile() && entry.name === sessionId + ".jsonl") found.push(filename);
    }
  };
  const home = path.join(base, "home");
  const configuration = path.join(home, ".claude");
  const projects = path.join(configuration, "projects");
  for (const directory of [home, configuration, projects]) {
    if ((await lstat(directory)).isSymbolicLink() || normalized(await realpath(directory)) !== normalized(directory)) throw new Error("NATIVE_AGENT_CHECKPOINT_SYMLINK_DENIED");
  }
  await walk(projects, 0);
  if (found.length !== 1) throw new Error("NATIVE_AGENT_CHECKPOINT_MISSING_OR_AMBIGUOUS");
  const before = await lstat(found[0]);
  if (!before.isFile() || before.isSymbolicLink() || before.size < 1 || before.size > 32 * 1024 * 1024) throw new Error("NATIVE_AGENT_CHECKPOINT_FILE_INVALID");
  const file = await open(found[0], "r");
  try {
    const opened = await file.stat();
    if (opened.ino !== before.ino || opened.dev !== before.dev || opened.size !== before.size) throw new Error("NATIVE_AGENT_CHECKPOINT_FILE_CHANGED");
    const bytes = await file.readFile();
    const after = await lstat(found[0]);
    if (after.isSymbolicLink() || after.ino !== opened.ino || after.size !== bytes.length || after.mtimeMs !== opened.mtimeMs) throw new Error("NATIVE_AGENT_CHECKPOINT_FILE_CHANGED");
    return createHash("sha256").update(bytes).digest("hex");
  } finally { await file.close(); }
}
