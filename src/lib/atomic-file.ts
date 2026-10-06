import { randomUUID } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  openSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import {
  open,
  rename,
  stat,
  unlink,
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";

export type AtomicJsonWriteOptions = Readonly<{
  trailingNewline?: boolean;
}>;

const WINDOWS_REPLACE_ERROR_CODES = new Set([
  "EACCES",
  "EBUSY",
  "EEXIST",
  "ENOTEMPTY",
  "EPERM",
]);

function errorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object" || !("code" in error)) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

function isMissingFileError(error: unknown): boolean {
  return errorCode(error) === "ENOENT";
}

function isWindowsReplaceError(error: unknown): boolean {
  const code = errorCode(error);
  return process.platform === "win32" && Boolean(code && WINDOWS_REPLACE_ERROR_CODES.has(code));
}

function siblingPath(targetPath: string, kind: "tmp" | "replace-backup"): string {
  return join(
    dirname(targetPath),
    `.${basename(targetPath)}.${process.pid}.${Date.now()}.${randomUUID()}.${kind}`,
  );
}

function targetModeSync(targetPath: string): number {
  try {
    return statSync(targetPath).mode & 0o777;
  } catch (error) {
    if (isMissingFileError(error)) return 0o666;
    throw error;
  }
}

async function targetMode(targetPath: string): Promise<number> {
  try {
    return (await stat(targetPath)).mode & 0o777;
  } catch (error) {
    if (isMissingFileError(error)) return 0o666;
    throw error;
  }
}

function removeReplacementBackupBestEffortSync(backupPath: string): void {
  try {
    unlinkSync(backupPath);
  } catch {
    // The new target is already durable. Retaining the old copy is safer than
    // reporting the successful write as failed solely because cleanup was blocked.
  }
}

async function removeReplacementBackupBestEffort(backupPath: string): Promise<void> {
  try {
    await unlink(backupPath);
  } catch {
    // See the synchronous counterpart above.
  }
}

function replaceFileSync(temporaryPath: string, targetPath: string): void {
  try {
    renameSync(temporaryPath, targetPath);
    return;
  } catch (error) {
    if (!isWindowsReplaceError(error)) throw error;
  }

  const backupPath = siblingPath(targetPath, "replace-backup");
  try {
    renameSync(targetPath, backupPath);
  } catch (error) {
    if (isMissingFileError(error)) {
      renameSync(temporaryPath, targetPath);
      return;
    }
    throw error;
  }

  try {
    renameSync(temporaryPath, targetPath);
  } catch (replacementError) {
    try {
      renameSync(backupPath, targetPath);
    } catch (restoreError) {
      throw new AggregateError(
        [replacementError, restoreError],
        `Atomic replacement failed for ${targetPath}; the previous file remains recoverable at ${backupPath}`,
      );
    }
    throw replacementError;
  }

  removeReplacementBackupBestEffortSync(backupPath);
}

async function replaceFile(temporaryPath: string, targetPath: string): Promise<void> {
  try {
    await rename(temporaryPath, targetPath);
    return;
  } catch (error) {
    if (!isWindowsReplaceError(error)) throw error;
  }

  const backupPath = siblingPath(targetPath, "replace-backup");
  try {
    await rename(targetPath, backupPath);
  } catch (error) {
    if (isMissingFileError(error)) {
      await rename(temporaryPath, targetPath);
      return;
    }
    throw error;
  }

  try {
    await rename(temporaryPath, targetPath);
  } catch (replacementError) {
    try {
      await rename(backupPath, targetPath);
    } catch (restoreError) {
      throw new AggregateError(
        [replacementError, restoreError],
        `Atomic replacement failed for ${targetPath}; the previous file remains recoverable at ${backupPath}`,
      );
    }
    throw replacementError;
  }

  await removeReplacementBackupBestEffort(backupPath);
}

function serializedJson(data: unknown, trailingNewline: boolean): string {
  const serialized = JSON.stringify(data, null, 2);
  if (serialized === undefined) {
    throw new TypeError("JSON state must serialize to a defined value");
  }
  return trailingNewline ? `${serialized}\n` : serialized;
}

export function atomicWriteJsonSync(
  targetPath: string,
  data: unknown,
  options: AtomicJsonWriteOptions = {},
): void {
  const contents = serializedJson(data, options.trailingNewline === true);
  const temporaryPath = siblingPath(targetPath, "tmp");
  const failures: unknown[] = [];
  let descriptor: number | undefined;

  try {
    descriptor = openSync(temporaryPath, "wx", targetModeSync(targetPath));
    writeFileSync(descriptor, contents, "utf8");
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    replaceFileSync(temporaryPath, targetPath);
    return;
  } catch (error) {
    failures.push(error);
  }

  if (descriptor !== undefined) {
    try {
      closeSync(descriptor);
    } catch (error) {
      failures.push(error);
    }
  }

  try {
    unlinkSync(temporaryPath);
  } catch (error) {
    if (!isMissingFileError(error)) failures.push(error);
  }

  if (failures.length === 1) throw failures[0];
  throw new AggregateError(failures, `Atomic JSON write failed for ${targetPath}`);
}

export async function atomicWriteJson(
  targetPath: string,
  data: unknown,
  options: AtomicJsonWriteOptions = {},
): Promise<void> {
  const contents = serializedJson(data, options.trailingNewline === true);
  const temporaryPath = siblingPath(targetPath, "tmp");
  const failures: unknown[] = [];
  let handle: Awaited<ReturnType<typeof open>> | undefined;

  try {
    handle = await open(temporaryPath, "wx", await targetMode(targetPath));
    await handle.writeFile(contents, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await replaceFile(temporaryPath, targetPath);
    return;
  } catch (error) {
    failures.push(error);
  }

  if (handle) {
    try {
      await handle.close();
    } catch (error) {
      failures.push(error);
    }
  }

  try {
    await unlink(temporaryPath);
  } catch (error) {
    if (!isMissingFileError(error)) failures.push(error);
  }

  if (failures.length === 1) throw failures[0];
  throw new AggregateError(failures, `Atomic JSON write failed for ${targetPath}`);
}
