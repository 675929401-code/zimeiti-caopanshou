import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

export const CANONICAL_FORWARD_MIGRATION_NAME = /^([0-9]{14})_([a-z0-9_]+)\.sql$/u;
export const FORBIDDEN_FORWARD_DIRECTION_TOKEN = /(?:^|_)(?:down|rollback)(?:_|\.|$)/u;
const CANONICAL_LEGACY_ROLLBACK_NAME = /^[0-9]{14}_[a-z0-9_]+\.rollback\.sql$/u;

/** @typedef {"directory" | "file" | "other" | "symlink"} ForwardEntryKind */
/** @typedef {{ kind: ForwardEntryKind, relativePath: string }} ForwardEntry */

/**
 * @param {ForwardEntry} entry
 * @returns {string[]}
 */
export function forwardMigrationEntryViolations(entry) {
  const violations = [];
  const relativePath = String(entry?.relativePath || "");
  const name = path.posix.basename(relativePath.replaceAll("\\", "/"));
  if (!relativePath || relativePath.includes("/") || relativePath.includes("\\")) {
    violations.push("NOT_TOP_LEVEL");
  }
  if (entry?.kind !== "file") {
    violations.push(entry?.kind === "symlink" ? "SYMLINK_OR_REPARSE_POINT" : "NOT_REGULAR_FILE");
  }
  if (!/^[\x00-\x7f]+$/u.test(name)) violations.push("NON_ASCII_NAME");
  if (name !== name.normalize("NFKC")) violations.push("NFKC_NAME_DIFFERENCE");
  if (!CANONICAL_FORWARD_MIGRATION_NAME.test(name)) violations.push("NON_CANONICAL_FORWARD_NAME");
  if (FORBIDDEN_FORWARD_DIRECTION_TOKEN.test(name)) violations.push("ROLLBACK_OR_DOWN_NAME");
  return violations;
}

/**
 * @param {string} name
 * @returns {{ version: string, slug: string } | null}
 */
export function parseForwardMigrationName(name) {
  const match = CANONICAL_FORWARD_MIGRATION_NAME.exec(name);
  return match ? { version: match[1], slug: match[2] } : null;
}

/** @param {string} relativePath */
export function isCanonicalForwardMigrationRelativePath(relativePath) {
  const value = String(relativePath || "");
  return value.length > 0
    && !value.includes("/")
    && !value.includes("\\")
    && /^[\x00-\x7f]+$/u.test(value)
    && value === value.normalize("NFKC")
    && CANONICAL_FORWARD_MIGRATION_NAME.test(value)
    && !FORBIDDEN_FORWARD_DIRECTION_TOKEN.test(value);
}

/**
 * Parse the NUL-delimited output of `git ls-files -s -z`. The first TAB is
 * the only metadata/path separator, so spaces, TABs and newlines in the path
 * cannot be confused with Git metadata. `ls-files` reports index entries, not
 * rename pairs; a rename is therefore validated under its current index path.
 *
 * @param {string} rawIndex
 * @returns {{ entries: Array<{ mode: string, objectId: string, stage: number, path: string }>, errors: string[] }}
 */
export function parseGitIndexEntries(rawIndex) {
  const entries = [];
  const errors = [];
  for (const record of String(rawIndex || "").split("\0")) {
    if (!record) continue;
    const separator = record.indexOf("\t");
    if (separator < 0) {
      errors.push("GIT_INDEX_RECORD_MISSING_SEPARATOR");
      continue;
    }
    const metadata = record.slice(0, separator);
    const indexedPath = record.slice(separator + 1);
    const match = /^(\d{6}) ([0-9a-f]{40}|[0-9a-f]{64}) ([0-3])$/u.exec(metadata);
    if (!match || !indexedPath) {
      errors.push("GIT_INDEX_RECORD_INVALID");
      continue;
    }
    entries.push({
      mode: match[1],
      objectId: match[2],
      stage: Number(match[3]),
      path: indexedPath,
    });
  }
  return { entries, errors };
}

/**
 * Parse the NUL-delimited output of `git ls-tree -r -z HEAD`. Tree objects are
 * the immutable HEAD side of the release comparison; the current index alone
 * cannot reveal a staged deletion or rename.
 *
 * @param {string} rawTree
 * @returns {{ entries: Array<{ mode: string, type: string, objectId: string, path: string }>, errors: string[] }}
 */
export function parseGitTreeEntries(rawTree) {
  const entries = [];
  const errors = [];
  for (const record of String(rawTree || "").split("\0")) {
    if (!record) continue;
    const separator = record.indexOf("\t");
    if (separator < 0) {
      errors.push("GIT_HEAD_RECORD_MISSING_SEPARATOR");
      continue;
    }
    const metadata = record.slice(0, separator);
    const treePath = record.slice(separator + 1);
    const match = /^(\d{6}) (blob|tree|commit) ([0-9a-f]{40}|[0-9a-f]{64})$/u.exec(metadata);
    if (!match || !treePath) {
      errors.push("GIT_HEAD_RECORD_INVALID");
      continue;
    }
    entries.push({
      mode: match[1],
      type: match[2],
      objectId: match[3],
      path: treePath,
    });
  }
  return { entries, errors };
}

/**
 * @param {string} rawIndex
 * @returns {{ symlinkPaths: string[], nonRegularPaths: string[], unmergedPaths: string[], parseErrors: string[] }}
 */
export function inspectGitIndexRaw(rawIndex) {
  const parsed = parseGitIndexEntries(rawIndex);
  return {
    symlinkPaths: parsed.entries.filter((entry) => entry.mode === "120000").map((entry) => entry.path),
    nonRegularPaths: parsed.entries
      .filter((entry) => !["100644", "100755"].includes(entry.mode))
      .map((entry) => `${entry.mode}:${entry.path}`),
    unmergedPaths: parsed.entries.filter((entry) => entry.stage !== 0).map((entry) => entry.path),
    parseErrors: parsed.errors,
  };
}

function slash(value) {
  return String(value || "").split(path.sep).join("/");
}

function comparablePath(value) {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function isInside(rootPath, candidatePath, allowRoot = false) {
  const relative = path.relative(path.resolve(rootPath), path.resolve(candidatePath));
  if (!relative || relative === ".") return allowRoot;
  return !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative);
}

function lexicalPathExists(filePath) {
  try {
    fs.lstatSync(filePath);
    return true;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function emptyGitIndex(overrides = {}) {
  return {
    checked: false,
    repositoryRoot: null,
    symlinkPaths: [],
    nonRegularPaths: [],
    unmergedPaths: [],
    invalidPaths: [],
    stagedChangePaths: [],
    worktreeDriftPaths: [],
    trackedForwardPaths: [],
    stagedNewForwardPaths: [],
    untrackedNewForwardPaths: [],
    uncoveredForwardPaths: [],
    indexFlaggedPaths: [],
    legacyTombstonePaths: [],
    relocationErrors: [],
    errors: [],
    ...overrides,
  };
}

/**
 * A lexical containment check is not enough on Windows: any intermediate
 * component may be a junction/reparse point while the final directory itself
 * appears to be an ordinary directory. Anchor the trusted project root once,
 * then require every existing descendant component to resolve to the exact
 * path expected below that anchor.
 *
 * @param {string} projectRoot
 * @param {string} migrationRoot
 */
function inspectMigrationPathBoundary(projectRoot, migrationRoot) {
  const errors = [];
  const relative = path.relative(projectRoot, migrationRoot);
  if (!relative || relative === ".") {
    return { errors: ["MIGRATION_ROOT_EQUALS_PROJECT_ROOT"], relative: null };
  }
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    return { errors: ["MIGRATION_ROOT_OUTSIDE_PROJECT_ROOT"], relative: null };
  }

  let realProjectRoot;
  try {
    realProjectRoot = fs.realpathSync.native(projectRoot);
  } catch {
    return { errors: ["PROJECT_ROOT_UNREADABLE"], relative };
  }

  const segments = relative.split(path.sep).filter(Boolean);
  let lexicalCursor = projectRoot;
  let expectedRealCursor = realProjectRoot;
  for (const segment of segments) {
    lexicalCursor = path.join(lexicalCursor, segment);
    expectedRealCursor = path.join(expectedRealCursor, segment);
    if (!lexicalPathExists(lexicalCursor)) break;
    try {
      const stat = fs.lstatSync(lexicalCursor);
      const actualRealCursor = fs.realpathSync.native(lexicalCursor);
      if (stat.isSymbolicLink() || comparablePath(actualRealCursor) !== comparablePath(expectedRealCursor)) {
        errors.push(`MIGRATION_PATH_SYMLINK_OR_REPARSE_POINT:${slash(path.relative(projectRoot, lexicalCursor))}`);
        break;
      }
      if (!isInside(realProjectRoot, actualRealCursor, false)) {
        errors.push(`MIGRATION_PATH_ESCAPES_PROJECT_ROOT:${slash(path.relative(projectRoot, lexicalCursor))}`);
        break;
      }
    } catch {
      errors.push(`MIGRATION_PATH_COMPONENT_UNREADABLE:${slash(path.relative(projectRoot, lexicalCursor))}`);
      break;
    }
  }
  return { errors, relative };
}

function isSafeProjectRelativePath(value) {
  return typeof value === "string"
    && value.length > 0
    && value === slash(value)
    && value === path.posix.normalize(value)
    && !path.posix.isAbsolute(value)
    && value !== ".."
    && !value.startsWith("../")
    && !value.includes("/../")
    && !value.includes("\\")
    && !value.includes(":")
    && !value.includes("\0");
}

function gitPathFromProjectRelative(repositoryRoot, projectRoot, projectRelativePath) {
  const projectPrefix = slash(path.relative(repositoryRoot, projectRoot));
  return projectPrefix && projectPrefix !== "."
    ? path.posix.join(projectPrefix, projectRelativePath)
    : projectRelativePath;
}

function runGitBytes(repositoryRoot, arguments_) {
  return spawnSync("git", ["-C", repositoryRoot, ...arguments_], {
    encoding: null,
    windowsHide: true,
  });
}

/**
 * @param {{ from: string, to: string, sha256: string }} receipt
 * @param {{ projectRoot: string, repositoryRoot: string, rollbackProjectPath: string | null, headSourceEntry?: { mode: string, type: string, objectId: string, path: string }, indexSourceEntries: Array<{ mode: string, objectId: string, stage: number, path: string }>, headTargetEntry?: { mode: string, type: string, objectId: string, path: string }, indexTargetEntries: Array<{ mode: string, objectId: string, stage: number, path: string }>, changedWorktreePaths: Set<string> }} context
 */
function verifyLegacyTombstone(receipt, context) {
  const errors = [];
  const sourcePath = path.resolve(context.projectRoot, ...receipt.from.split("/"));
  const targetPath = path.resolve(context.projectRoot, ...receipt.to.split("/"));
  if (lexicalPathExists(sourcePath)) errors.push(`${receipt.from}:LEGACY_SOURCE_NOT_DELETED`);

  const expectedSourceIndexPath = gitPathFromProjectRelative(context.repositoryRoot, context.projectRoot, receipt.from);
  const expectedTargetIndexPath = gitPathFromProjectRelative(context.repositoryRoot, context.projectRoot, receipt.to);
  const headSource = context.headSourceEntry;
  const indexTarget = context.indexTargetEntries.length === 1 ? context.indexTargetEntries[0] : undefined;
  if (!headSource || headSource.path !== expectedSourceIndexPath || headSource.mode !== "100644" || headSource.type !== "blob") {
    errors.push(`${receipt.from}:LEGACY_HEAD_SOURCE_MISSING_OR_INVALID`);
  }
  if (context.indexSourceEntries.length !== 0) {
    errors.push(`${receipt.from}:LEGACY_SOURCE_NOT_STAGED_DELETED`);
  }
  if (context.headTargetEntry) {
    errors.push(`${receipt.from}:LEGACY_TARGET_ALREADY_IN_HEAD`);
  }
  if (!indexTarget
    || indexTarget.path !== expectedTargetIndexPath
    || indexTarget.mode !== "100644"
    || indexTarget.stage !== 0) {
    errors.push(`${receipt.from}:LEGACY_TARGET_NOT_STAGED_REGULAR`);
  }

  const indexBlob = indexTarget
    ? runGitBytes(context.repositoryRoot, ["cat-file", "blob", indexTarget.objectId])
    : { status: 1, stdout: null };
  const headBlob = headSource
    ? runGitBytes(context.repositoryRoot, ["cat-file", "blob", headSource.objectId])
    : { status: 1, stdout: null };
  if (indexBlob.status !== 0 || !Buffer.isBuffer(indexBlob.stdout)) {
    errors.push(`${receipt.from}:LEGACY_INDEX_BLOB_UNREADABLE`);
  } else if (sha256(indexBlob.stdout) !== receipt.sha256) {
    errors.push(`${receipt.from}:LEGACY_INDEX_BLOB_HASH_MISMATCH`);
  }
  if (headBlob.status !== 0 || !Buffer.isBuffer(headBlob.stdout)) {
    errors.push(`${receipt.from}:LEGACY_HEAD_BLOB_UNREADABLE`);
  } else if (sha256(headBlob.stdout) !== receipt.sha256) {
    errors.push(`${receipt.from}:LEGACY_HEAD_BLOB_HASH_MISMATCH`);
  }
  if (context.changedWorktreePaths.has(expectedTargetIndexPath)) {
    errors.push(`${receipt.from}:LEGACY_INDEX_TARGET_WORKTREE_DRIFT`);
  }

  if (!context.rollbackProjectPath) {
    errors.push(`${receipt.from}:LEGACY_ROLLBACK_ROOT_REQUIRED`);
    return errors;
  }
  const rollbackRoot = path.resolve(context.projectRoot, ...context.rollbackProjectPath.split("/"));
  const rollbackBoundary = inspectMigrationPathBoundary(context.projectRoot, rollbackRoot);
  if (rollbackBoundary.errors.length > 0) {
    errors.push(...rollbackBoundary.errors.map((error) => `${receipt.from}:TARGET_${error}`));
    return errors;
  }
  if (!lexicalPathExists(targetPath)) {
    errors.push(`${receipt.from}:LEGACY_TARGET_MISSING`);
  } else {
    try {
      const targetStat = fs.lstatSync(targetPath);
      if (!targetStat.isFile() || targetStat.isSymbolicLink() || targetStat.nlink !== 1) {
        errors.push(`${receipt.from}:LEGACY_TARGET_NOT_SINGLE_LINK_REGULAR_FILE`);
      } else if (sha256(fs.readFileSync(targetPath)) !== receipt.sha256) {
        errors.push(`${receipt.from}:LEGACY_TARGET_HASH_MISMATCH`);
      }
    } catch {
      errors.push(`${receipt.from}:LEGACY_TARGET_UNREADABLE`);
    }
  }
  return errors;
}

/** @param {fs.Dirent} entry @param {string} absolutePath @returns {ForwardEntryKind} */
function classifyEntry(entry, absolutePath) {
  if (entry.isSymbolicLink()) return "symlink";
  const stat = fs.lstatSync(absolutePath);
  if (stat.isSymbolicLink()) return "symlink";
  if (entry.isFile() && stat.isFile()) return "file";
  if (entry.isDirectory() && stat.isDirectory()) return "directory";
  return "other";
}

/**
 * @param {string} projectRoot
 * @param {string} migrationRoot
 * @param {"required" | "disabled"} gitIndexMode
 * @param {Array<{ from: string, to: string, sha256: string }>} legacyRollbackRelocations
 * @param {string | null} rollbackRoot
 * @param {ForwardEntry[]} forwardEntries
 */
function inspectGitIndex(projectRoot, migrationRoot, gitIndexMode, legacyRollbackRelocations, rollbackRoot, forwardEntries) {
  if (gitIndexMode === "disabled") {
    return emptyGitIndex();
  }
  if (gitIndexMode !== "required") {
    return emptyGitIndex({ errors: ["GIT_INDEX_MODE_INVALID"] });
  }
  const repository = spawnSync("git", ["-C", projectRoot, "rev-parse", "--show-toplevel"], {
    encoding: "utf8",
    windowsHide: true,
  });
  if (repository.status !== 0) {
    return emptyGitIndex({ errors: ["GIT_INDEX_UNREADABLE"] });
  }
  const repositoryRoot = path.resolve(repository.stdout.trim());
  const relativeMigrationRoot = path.relative(repositoryRoot, migrationRoot);
  if (!relativeMigrationRoot || relativeMigrationRoot === ".") {
    return emptyGitIndex({ repositoryRoot, errors: ["MIGRATION_ROOT_EQUALS_GIT_ROOT"] });
  }
  if (relativeMigrationRoot.startsWith(`..${path.sep}`) || path.isAbsolute(relativeMigrationRoot)) {
    return emptyGitIndex({
      repositoryRoot,
      errors: ["MIGRATION_ROOT_OUTSIDE_GIT_WORKTREE"],
    });
  }
  const headCommit = spawnSync("git", ["-C", repositoryRoot, "rev-parse", "--verify", "--quiet", "HEAD^{commit}"], {
    encoding: "utf8",
    windowsHide: true,
  });
  if (headCommit.status !== 0) {
    return emptyGitIndex({ repositoryRoot, errors: ["GIT_HEAD_UNBORN"] });
  }

  const migrationRepositoryPath = slash(relativeMigrationRoot);
  const migrationProjectPath = slash(path.relative(projectRoot, migrationRoot));
  const rollbackProjectPath = rollbackRoot ? slash(path.relative(projectRoot, rollbackRoot)) : null;
  const relocationErrors = [];
  const receiptContexts = [];
  const relocationSources = new Set();
  const relocationTargets = new Set();
  for (const [receiptIndex, candidate] of legacyRollbackRelocations.entries()) {
    const keys = candidate && typeof candidate === "object" ? Object.keys(candidate).sort() : [];
    const from = candidate && typeof candidate === "object" ? candidate.from : null;
    const to = candidate && typeof candidate === "object" ? candidate.to : null;
    const expectedSha256 = candidate && typeof candidate === "object" ? candidate.sha256 : null;
    const valid = keys.join(",") === "from,sha256,to"
      && isSafeProjectRelativePath(from)
      && isSafeProjectRelativePath(to)
      && path.posix.dirname(from) === `${migrationProjectPath}/rollback`
      && rollbackProjectPath !== null
      && isSafeProjectRelativePath(rollbackProjectPath)
      && path.posix.dirname(to) === rollbackProjectPath
      && path.posix.basename(from) === path.posix.basename(to)
      && CANONICAL_LEGACY_ROLLBACK_NAME.test(path.posix.basename(from))
      && typeof expectedSha256 === "string"
      && /^[0-9a-f]{64}$/u.test(expectedSha256);
    if (!valid) {
      relocationErrors.push(`LEGACY_RELOCATION_POLICY_INVALID:${receiptIndex}`);
      continue;
    }
    const sourceIndexPath = gitPathFromProjectRelative(repositoryRoot, projectRoot, from);
    const targetIndexPath = gitPathFromProjectRelative(repositoryRoot, projectRoot, to);
    if (relocationSources.has(sourceIndexPath) || relocationTargets.has(targetIndexPath)) {
      relocationErrors.push(`LEGACY_RELOCATION_POLICY_DUPLICATE:${receiptIndex}`);
      continue;
    }
    relocationSources.add(sourceIndexPath);
    relocationTargets.add(targetIndexPath);
    receiptContexts.push({ receipt: candidate, sourceIndexPath, targetIndexPath });
  }

  const pathspecs = [migrationRepositoryPath, ...relocationTargets];
  const index = spawnSync("git", ["-C", repositoryRoot, "ls-files", "-s", "-z", "--", ...pathspecs], {
    encoding: "utf8",
    windowsHide: true,
  });
  if (index.status !== 0) {
    return emptyGitIndex({ repositoryRoot, errors: ["GIT_INDEX_UNREADABLE"] });
  }
  const headTree = spawnSync("git", ["-C", repositoryRoot, "ls-tree", "-r", "-z", "HEAD", "--", ...pathspecs], {
    encoding: "utf8",
    windowsHide: true,
  });
  const worktreeDiff = spawnSync("git", ["-C", repositoryRoot, "diff-files", "--name-only", "-z", "--", ...pathspecs], {
    encoding: "utf8",
    windowsHide: true,
  });
  const untracked = spawnSync("git", ["-C", repositoryRoot, "ls-files", "--others", "--exclude-standard", "-z", "--", migrationRepositoryPath], {
    encoding: "utf8",
    windowsHide: true,
  });
  const indexFlags = spawnSync("git", ["-C", repositoryRoot, "ls-files", "-v", "-z", "--", ...pathspecs], {
    encoding: "utf8",
    windowsHide: true,
  });
  if (headTree.status !== 0 || worktreeDiff.status !== 0 || untracked.status !== 0 || indexFlags.status !== 0) {
    const errors = [];
    if (headTree.status !== 0) errors.push("GIT_HEAD_TREE_UNREADABLE");
    if (worktreeDiff.status !== 0) errors.push("GIT_WORKTREE_DIFF_UNREADABLE");
    if (untracked.status !== 0) errors.push("GIT_UNTRACKED_INVENTORY_UNREADABLE");
    if (indexFlags.status !== 0) errors.push("GIT_INDEX_FLAGS_UNREADABLE");
    return emptyGitIndex({ repositoryRoot, errors });
  }
  const changedWorktreePaths = new Set(String(worktreeDiff.stdout || "").split("\0").filter(Boolean));
  const untrackedPaths = new Set(String(untracked.stdout || "").split("\0").filter(Boolean));
  const parsedIndex = parseGitIndexEntries(index.stdout);
  const parsedHead = parseGitTreeEntries(headTree.stdout);
  const inspection = inspectGitIndexRaw(index.stdout);
  const indexEntriesByPath = new Map();
  for (const entry of parsedIndex.entries) {
    const existing = indexEntriesByPath.get(entry.path) || [];
    existing.push(entry);
    indexEntriesByPath.set(entry.path, existing);
  }
  const headEntriesByPath = new Map(parsedHead.entries.map((entry) => [entry.path, entry]));
  const indexFlaggedPaths = String(indexFlags.stdout || "")
    .split("\0")
    .filter(Boolean)
    .filter((record) => !record.startsWith("H "))
    .map((record) => record.slice(2));
  const invalidPaths = new Set();
  const stagedChangePaths = new Set();
  const worktreeDriftPaths = new Set();
  const trackedForwardPaths = new Set();
  const stagedNewForwardPaths = new Set();
  const untrackedNewForwardPaths = new Set();
  const uncoveredForwardPaths = new Set();
  const legacyTombstonePaths = [];
  const migrationIndexEntries = parsedIndex.entries.filter((entry) => (
    entry.path.startsWith(`${migrationRepositoryPath}/`)
  ));
  const migrationHeadEntries = parsedHead.entries.filter((entry) => (
    entry.path.startsWith(`${migrationRepositoryPath}/`)
  ));
  for (const entry of migrationIndexEntries) {
    const relativePath = path.posix.relative(migrationRepositoryPath, entry.path);
    const topLevelCanonical = isCanonicalForwardMigrationRelativePath(relativePath);
    if (topLevelCanonical) {
      const worktreePath = path.resolve(repositoryRoot, ...entry.path.split("/"));
      if (!lexicalPathExists(worktreePath)) {
        worktreeDriftPaths.add(entry.path);
      } else if (changedWorktreePaths.has(entry.path)) {
        worktreeDriftPaths.add(entry.path);
      }
      const headEntry = headEntriesByPath.get(entry.path);
      if (!headEntry) stagedNewForwardPaths.add(entry.path);
      else if (headEntry.mode !== entry.mode || headEntry.objectId !== entry.objectId || headEntry.type !== "blob") {
        stagedChangePaths.add(entry.path);
      } else trackedForwardPaths.add(entry.path);
      continue;
    }
    invalidPaths.add(entry.path);
  }
  for (const headEntry of migrationHeadEntries) {
    const relativePath = path.posix.relative(migrationRepositoryPath, headEntry.path);
    if (isCanonicalForwardMigrationRelativePath(relativePath)) {
      const indexEntries = indexEntriesByPath.get(headEntry.path) || [];
      if (indexEntries.length !== 1) stagedChangePaths.add(headEntry.path);
      continue;
    }
    if (!relocationSources.has(headEntry.path)) invalidPaths.add(headEntry.path);
  }

  for (const context of receiptContexts) {
    const tombstoneErrors = verifyLegacyTombstone(context.receipt, {
      projectRoot,
      repositoryRoot,
      rollbackProjectPath,
      headSourceEntry: headEntriesByPath.get(context.sourceIndexPath),
      indexSourceEntries: indexEntriesByPath.get(context.sourceIndexPath) || [],
      headTargetEntry: headEntriesByPath.get(context.targetIndexPath),
      indexTargetEntries: indexEntriesByPath.get(context.targetIndexPath) || [],
      changedWorktreePaths,
    });
    if (tombstoneErrors.length > 0) relocationErrors.push(...tombstoneErrors);
    else legacyTombstonePaths.push(context.sourceIndexPath);
  }

  for (const entry of forwardEntries) {
    if (forwardMigrationEntryViolations(entry).length > 0) continue;
    const repositoryPath = path.posix.join(migrationRepositoryPath, entry.relativePath);
    const indexEntries = indexEntriesByPath.get(repositoryPath) || [];
    const headEntry = headEntriesByPath.get(repositoryPath);
    if (indexEntries.length === 1) continue;
    if (!headEntry && untrackedPaths.has(repositoryPath)) {
      untrackedNewForwardPaths.add(repositoryPath);
    } else {
      uncoveredForwardPaths.add(repositoryPath);
    }
  }
  return {
    checked: true,
    repositoryRoot,
    symlinkPaths: inspection.symlinkPaths,
    nonRegularPaths: inspection.nonRegularPaths,
    unmergedPaths: inspection.unmergedPaths,
    invalidPaths: [...invalidPaths].sort(),
    stagedChangePaths: [...stagedChangePaths].sort(),
    worktreeDriftPaths: [...worktreeDriftPaths].sort(),
    trackedForwardPaths: [...trackedForwardPaths].sort(),
    stagedNewForwardPaths: [...stagedNewForwardPaths].sort(),
    untrackedNewForwardPaths: [...untrackedNewForwardPaths].sort(),
    uncoveredForwardPaths: [...uncoveredForwardPaths].sort(),
    indexFlaggedPaths: [...new Set(indexFlaggedPaths)].sort(),
    legacyTombstonePaths,
    relocationErrors,
    errors: [...inspection.parseErrors, ...parsedHead.errors],
  };
}

/**
 * @param {{ projectRoot: string, migrationRoot: string, rollbackRoot?: string, legacyRollbackRelocations?: Array<{ from: string, to: string, sha256: string }>, gitIndexMode?: "required" | "disabled" }} options
 */
export function inspectForwardMigrationRoot(options) {
  const projectRoot = path.resolve(options.projectRoot);
  const migrationRoot = path.resolve(options.migrationRoot);
  const rollbackRoot = options.rollbackRoot ? path.resolve(options.rollbackRoot) : null;
  const legacyRollbackRelocations = Array.isArray(options.legacyRollbackRelocations)
    ? options.legacyRollbackRelocations
    : [];
  const gitIndexMode = options.gitIndexMode || "required";
  const pathBoundary = inspectMigrationPathBoundary(projectRoot, migrationRoot);
  const rootErrors = [...pathBoundary.errors];
  const entries = [];
  if (rootErrors.length > 0) {
    // Do not follow or enumerate an out-of-bound/reparse path.
  } else if (!fs.existsSync(migrationRoot)) {
    rootErrors.push("MIGRATION_ROOT_MISSING");
  } else {
    const rootStat = fs.lstatSync(migrationRoot);
    if (rootStat.isSymbolicLink()) rootErrors.push("MIGRATION_ROOT_SYMLINK_OR_REPARSE_POINT");
    if (!rootStat.isDirectory()) rootErrors.push("MIGRATION_ROOT_NOT_DIRECTORY");
    if (rootErrors.length === 0) {
      for (const entry of fs.readdirSync(migrationRoot, { withFileTypes: true })) {
        const absolutePath = path.join(migrationRoot, entry.name);
        /** @type {ForwardEntryKind} */
        let kind = "other";
        try {
          kind = classifyEntry(entry, absolutePath);
        } catch {
          rootErrors.push(`ENTRY_LSTAT_FAILED:${entry.name}`);
        }
        entries.push({ relativePath: entry.name, kind });
      }
    }
  }
  const invalidEntries = entries
    .map((entry) => ({ entry, violations: forwardMigrationEntryViolations(entry) }))
    .filter(({ violations }) => violations.length > 0);
  const gitIndex = rootErrors.length > 0
    ? emptyGitIndex({ errors: ["GIT_INDEX_SKIPPED_UNSAFE_MIGRATION_ROOT"] })
    : inspectGitIndex(
      projectRoot,
      migrationRoot,
      gitIndexMode,
      legacyRollbackRelocations,
      rollbackRoot,
      entries,
    );
  if (gitIndex.symlinkPaths.length > 0) rootErrors.push("GIT_INDEX_SYMLINK_MODE_120000");
  if (gitIndex.nonRegularPaths.length > 0) rootErrors.push("GIT_INDEX_NON_REGULAR_MODE");
  if (gitIndex.unmergedPaths.length > 0) rootErrors.push("GIT_INDEX_UNMERGED_ENTRY");
  if (gitIndex.invalidPaths.length > 0) rootErrors.push("GIT_INDEX_NON_CANONICAL_PATH");
  if (gitIndex.stagedChangePaths.length > 0) rootErrors.push("GIT_HEAD_INDEX_DRIFT");
  if (gitIndex.worktreeDriftPaths.length > 0) rootErrors.push("GIT_INDEX_WORKTREE_DRIFT");
  if (gitIndex.uncoveredForwardPaths.length > 0) rootErrors.push("GIT_FORWARD_FILE_UNCOVERED");
  if (gitIndex.indexFlaggedPaths.length > 0) rootErrors.push("GIT_INDEX_UNSAFE_FLAGS");
  if (gitIndex.relocationErrors.length > 0) rootErrors.push("GIT_INDEX_LEGACY_TOMBSTONE_INVALID");
  rootErrors.push(...gitIndex.errors);
  return {
    valid: rootErrors.length === 0 && invalidEntries.length === 0,
    projectRoot,
    migrationRoot,
    entries,
    invalidEntries,
    rootErrors,
    gitIndex,
  };
}

/**
 * @param {{ projectRoot: string, migrationRoot: string, rollbackRoot?: string, legacyRollbackRelocations?: Array<{ from: string, to: string, sha256: string }>, gitIndexMode?: "required" | "disabled" }} options
 */
export function assertForwardMigrationRoot(options) {
  const report = inspectForwardMigrationRoot(options);
  if (report.valid) return report;
  const entryFailures = report.invalidEntries.map(({ entry, violations }) => (
    `${entry.relativePath}:${violations.join("+")}`
  ));
  const gitFailures = [
    ...report.gitIndex.symlinkPaths.map((indexedPath) => `120000:${indexedPath}`),
    ...report.gitIndex.nonRegularPaths,
    ...report.gitIndex.unmergedPaths.map((indexedPath) => `UNMERGED:${indexedPath}`),
    ...report.gitIndex.invalidPaths.map((indexedPath) => `INVALID_PATH:${indexedPath}`),
    ...report.gitIndex.stagedChangePaths.map((indexedPath) => `HEAD_INDEX_DRIFT:${indexedPath}`),
    ...report.gitIndex.worktreeDriftPaths.map((indexedPath) => `WORKTREE_DRIFT:${indexedPath}`),
    ...report.gitIndex.uncoveredForwardPaths.map((indexedPath) => `UNCOVERED_FORWARD:${indexedPath}`),
    ...report.gitIndex.indexFlaggedPaths.map((indexedPath) => `UNSAFE_INDEX_FLAG:${indexedPath}`),
    ...report.gitIndex.relocationErrors,
  ];
  const forwardWorktreeCount = report.entries.filter(
    (entry) => forwardMigrationEntryViolations(entry).length === 0,
  ).length;
  const coverage = [
    `worktree=${forwardWorktreeCount}`,
    `tracked=${report.gitIndex.trackedForwardPaths.length}`,
    `stagedNew=${report.gitIndex.stagedNewForwardPaths.length}`,
    `untrackedNew=${report.gitIndex.untrackedNewForwardPaths.length}`,
    `uncovered=${report.gitIndex.uncoveredForwardPaths.length}`,
    `legacyRelocations=${report.gitIndex.legacyTombstonePaths.length}`,
  ].join(";");
  throw new Error(
    `FORWARD_MIGRATION_ROOT_INVALID:${[...report.rootErrors, ...entryFailures, ...gitFailures].join(",")}:COVERAGE:${coverage}`,
  );
}
