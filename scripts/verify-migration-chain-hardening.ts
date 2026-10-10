import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  CANONICAL_FORWARD_MIGRATION_NAME,
  forwardMigrationEntryViolations,
  isCanonicalForwardMigrationRelativePath,
  inspectForwardMigrationRoot,
  inspectGitIndexRaw,
  parseGitIndexEntries,
} from "./lib/forward-migration-source-validator.mjs";

type Check = {
  name: string;
  passed: boolean;
  detail: string;
};

const root = process.cwd();
const checks: Check[] = [];
const releasePolicy = JSON.parse(readFileSync(path.join(root, "deploy", "policies", "release-policy.json"), "utf8")) as {
  database?: {
    rollbackRoot?: string;
    legacyRollbackRelocations?: Array<{ from: string; to: string; sha256: string }>;
  };
};

const forwardPaths = [
  "supabase/migrations/20260822032000_aid_integration_bridge.sql",
  "supabase/migrations/20260824024500_atomic_invited_registration.sql",
  "supabase/migrations/20260825062000_text_chat_controls.sql",
  "supabase/migrations/20260825121000_atomic_wallet_payment_fulfillment.sql",
] as const;

const rollbackPaths = [
  "supabase/rollbacks/20260822032000_aid_integration_bridge.rollback.sql",
  "supabase/rollbacks/20260824024500_atomic_invited_registration.rollback.sql",
  "supabase/rollbacks/20260825062000_text_chat_controls.rollback.sql",
  "supabase/rollbacks/20260825121000_atomic_wallet_payment_fulfillment.rollback.sql",
] as const;

function add(name: string, passed: boolean, detail: string) {
  checks.push({ name, passed, detail });
}

function read(relativePath: string): string {
  const absolutePath = path.join(root, relativePath);
  const present = existsSync(absolutePath);
  add(`file:${relativePath}`, present, present ? "present" : "missing");
  return present ? readFileSync(absolutePath, "utf8") : "";
}

function stripSqlComments(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//gu, "")
    .replace(/--[^\r\n]*/gu, "");
}

function isTransactionWrapped(sql: string): boolean {
  const executable = stripSqlComments(sql).trim();
  return /^BEGIN\s*;/iu.test(executable) && /COMMIT\s*;\s*$/iu.test(executable);
}

function hasBalancedDollarQuotes(sql: string): boolean {
  const counts = new Map<string, number>();
  for (const match of sql.matchAll(/\$[A-Za-z_][A-Za-z0-9_]*\$|\$\$/gu)) {
    const tag = match[0];
    counts.set(tag, (counts.get(tag) ?? 0) + 1);
  }
  return [...counts.values()].every((count) => count % 2 === 0);
}

function includesAll(name: string, sql: string, tokens: string[]) {
  const missing = tokens.filter((token) => !sql.includes(token));
  add(
    name,
    missing.length === 0,
    missing.length === 0 ? "all required tokens present" : `missing: ${missing.join(", ")}`,
  );
}

function verifyRollbackSafety(
  name: string,
  rollback: string,
  destructiveTables: string[],
) {
  const executable = stripSqlComments(rollback);
  add(`${name}:transaction`, isTransactionWrapped(rollback), "explicit BEGIN/COMMIT required");
  add(
    `${name}:no-cascade`,
    !/\bCASCADE\b/iu.test(executable),
    /\bCASCADE\b/iu.test(executable) ? "CASCADE token found" : "no CASCADE token",
  );
  add(
    `${name}:balanced-dollar-quotes`,
    hasBalancedDollarQuotes(rollback),
    "all dollar-quote delimiters must be paired",
  );
  add(
    `${name}:schema-reload`,
    /NOTIFY\s+pgrst\s*,\s*'reload schema'\s*;/iu.test(executable),
    "PostgREST schema reload notification required",
  );

  if (destructiveTables.length === 0) {
    add(
      `${name}:no-table-drop`,
      !/DROP\s+TABLE/iu.test(executable),
      "structural rollback must not delete table data",
    );
    return;
  }

  includesAll(`${name}:guarded-table-list`, rollback, destructiveTables);
  includesAll(`${name}:fail-closed-guard`, rollback, [
    "DO $rollback_guard$",
    "to_regclass",
    "SELECT count(*)",
    "RAISE EXCEPTION",
    "REFUSED_NONEMPTY",
  ]);

  for (const table of destructiveTables) {
    const dropPattern = new RegExp(`DROP\\s+TABLE\\s+IF\\s+EXISTS\\s+public\\.${table}\\s*;`, "iu");
    add(`${name}:drop:${table}`, dropPattern.test(executable), `guarded DROP TABLE for ${table}`);
  }
}

const forward = Object.fromEntries(forwardPaths.map((relativePath) => [relativePath, read(relativePath)]));
const rollbacks = Object.fromEntries(rollbackPaths.map((relativePath) => [relativePath, read(relativePath)]));

for (const relativePath of forwardPaths) {
  const sql = forward[relativePath];
  add(`forward:${relativePath}:transaction`, isTransactionWrapped(sql), "explicit BEGIN/COMMIT required");
  add(
    `forward:${relativePath}:balanced-dollar-quotes`,
    hasBalancedDollarQuotes(sql),
    "all dollar-quote delimiters must be paired",
  );
  add(
    `forward:${relativePath}:non-destructive`,
    !/DROP\s+TABLE/iu.test(stripSqlComments(sql)),
    "release-chain forward migration must not drop tables",
  );
}

const aid = forward[forwardPaths[0]];
add(
  "aid:user-id-fk-type",
  /user_id\s+(?:character\s+varying|varchar)\s*\(\s*36\s*\)\s+not\s+null\s+references\s+public\.users\s*\(\s*id\s*\)/iu.test(aid),
  "AID ticket user_id must match live users.id varchar(36)",
);
add(
  "aid:return-user-id-type",
  /returns\s+table\s*\([\s\S]*?user_id\s+(?:character\s+varying|varchar)\s*\(\s*36\s*\)/iu.test(aid),
  "consume RPC must return the same varchar(36) identity",
);
add(
  "aid:no-uuid-user-id",
  !/\buser_id\s+uuid\b/iu.test(stripSqlComments(aid)),
  "AID migration must not redeclare user_id as uuid",
);

const invitationRollback = rollbacks[rollbackPaths[1]];
includesAll("invitation-rollback:objects", invitationRollback, [
  "register_invited_user_atomic",
  "get_or_create_permanent_invitation_code",
  "invitation_codes_one_permanent_per_user",
  "invitation_codes_unique_normalized_code",
]);

verifyRollbackSafety("aid-rollback", rollbacks[rollbackPaths[0]], [
  "aid_launch_tickets",
  "aid_service_nonces",
]);
verifyRollbackSafety("invitation-rollback", invitationRollback, []);
verifyRollbackSafety("text-chat-rollback", rollbacks[rollbackPaths[2]], [
  "text_chat_conversation_settings",
  "text_chat_memories",
]);
verifyRollbackSafety("wallet-rollback", rollbacks[rollbackPaths[3]], [
  "wallet_ledger_entries",
  "wallet_operations",
]);

const migrationsDirectory = path.join(root, "supabase", "migrations");
type ForwardEntryKind = "directory" | "file" | "other" | "symlink";
type ForwardEntry = { kind: ForwardEntryKind; relativePath: string };

const forwardRootInspection = inspectForwardMigrationRoot({
  projectRoot: root,
  migrationRoot: migrationsDirectory,
  rollbackRoot: path.resolve(root, releasePolicy.database?.rollbackRoot || "supabase/rollbacks"),
  legacyRollbackRelocations: releasePolicy.database?.legacyRollbackRelocations || [],
  gitIndexMode: "required",
});
const forwardEntries = forwardRootInspection.entries as ForwardEntry[];
add(
  "migration-directory:top-level-canonical-ascii-regular-sql-only",
  forwardRootInspection.valid,
  forwardRootInspection.valid
    ? "production validator accepted only top-level canonical ASCII regular SQL files and a regular Git index"
    : [
      ...forwardRootInspection.rootErrors,
      ...forwardRootInspection.invalidEntries.map(({ entry, violations }) => `${entry.relativePath}:${violations.join("+")}`),
    ].join(", "),
);

const fixtureExpectations = [
  { entry: { relativePath: "nested", kind: "directory" as const }, expected: "NOT_REGULAR_FILE" },
  { entry: { relativePath: "nested/20990101000000_safe.sql", kind: "file" as const }, expected: "NOT_TOP_LEVEL" },
  { entry: { relativePath: "20990101000001_Mixed_case.sql", kind: "file" as const }, expected: "NON_CANONICAL_FORWARD_NAME" },
  { entry: { relativePath: "２０９９０１０１０００００２_fullwidth.sql", kind: "file" as const }, expected: "NFKC_NAME_DIFFERENCE" },
  { entry: { relativePath: "20990101000003_cyrillic_а.sql", kind: "file" as const }, expected: "NON_ASCII_NAME" },
  { entry: { relativePath: "20990101000004_down.sql", kind: "file" as const }, expected: "ROLLBACK_OR_DOWN_NAME" },
  { entry: { relativePath: "20990101000005_rollback.sql", kind: "file" as const }, expected: "ROLLBACK_OR_DOWN_NAME" },
  { entry: { relativePath: "20990101000006_safe.SQL", kind: "file" as const }, expected: "NON_CANONICAL_FORWARD_NAME" },
  { entry: { relativePath: "20990101000007_safe-name.sql", kind: "file" as const }, expected: "NON_CANONICAL_FORWARD_NAME" },
  { entry: { relativePath: "20990101000008_safe.sql", kind: "symlink" as const }, expected: "SYMLINK_OR_REPARSE_POINT" },
  { entry: { relativePath: "20990101000009_safe.sql", kind: "other" as const }, expected: "NOT_REGULAR_FILE" },
];
const maliciousIndexPathFixtures = [
  "nested/20990101000000_safe.sql",
  "20990101000001_Mixed_case.sql",
  "２０９９０１０１０００００２_fullwidth.sql",
  "20990101000003_cyrillic_а.sql",
  "20990101000004_safe.sql:ads",
  "20990101000005_safe.SQL",
];
add(
  "migration-directory:malicious-path-and-type-fixtures-rejected",
  fixtureExpectations.every(({ entry, expected }) => forwardMigrationEntryViolations(entry).includes(expected))
    && maliciousIndexPathFixtures.every((relativePath) => !isCanonicalForwardMigrationRelativePath(relativePath)),
  "the production validator rejects nested dir/file, mixed case, fullwidth, Cyrillic, down/rollback, uppercase extension, hyphen, symlink/reparse and nonregular fixtures",
);

const migrationNames = forwardEntries.filter((entry) => entry.kind === "file").map((entry) => entry.relativePath);
const versions = migrationNames
  .map((name) => CANONICAL_FORWARD_MIGRATION_NAME.test(name) ? name.slice(0, 14) : undefined)
  .filter((version): version is string => Boolean(version));
const duplicateVersions = [...new Set(versions.filter((version, index) => versions.indexOf(version) !== index))];
add(
  "migration-directory:unique-versions",
  duplicateVersions.length === 0,
  duplicateVersions.length === 0 ? "all 14-digit versions unique" : duplicateVersions.join(", "),
);

add(
  "migration-directory:git-index-has-no-mode-120000",
  forwardRootInspection.gitIndex.checked
    && forwardRootInspection.gitIndex.symlinkPaths.length === 0
    && forwardRootInspection.gitIndex.nonRegularPaths.length === 0
    && forwardRootInspection.gitIndex.unmergedPaths.length === 0
    && forwardRootInspection.gitIndex.invalidPaths.length === 0
    && forwardRootInspection.gitIndex.stagedChangePaths.length === 0
    && forwardRootInspection.gitIndex.worktreeDriftPaths.length === 0
    && forwardRootInspection.gitIndex.uncoveredForwardPaths.length === 0
    && forwardRootInspection.gitIndex.indexFlaggedPaths.length === 0
    && forwardRootInspection.gitIndex.relocationErrors.length === 0,
  forwardRootInspection.gitIndex.checked
    ? `production validator covered ${forwardRootInspection.gitIndex.trackedForwardPaths.length} tracked, ${forwardRootInspection.gitIndex.stagedNewForwardPaths.length} staged-new and ${forwardRootInspection.gitIndex.untrackedNewForwardPaths.length} untracked-new forward files`
    : forwardRootInspection.gitIndex.errors.join(", "),
);
const indexFixtureRaw = [
  `100644 ${"b".repeat(40)} 0\tsupabase/migrations/20990101000008_name with spaces.sql`,
  `120000 ${"a".repeat(40)} 0\tsupabase/migrations/20990101000009_safe.sql`,
  `100644 ${"c".repeat(40)} 2\tsupabase/migrations/20990101000010_safe.sql`,
].join("\0") + "\0";
const indexFixture = inspectGitIndexRaw(indexFixtureRaw);
const parsedIndexFixture = parseGitIndexEntries(indexFixtureRaw);
add(
  "migration-directory:index-mode-120000-fixture-rejected",
  indexFixture.symlinkPaths.length === 1
    && indexFixture.nonRegularPaths.length === 1
    && indexFixture.unmergedPaths.length === 1
    && parsedIndexFixture.errors.length === 0
    && parsedIndexFixture.entries[0]?.path.endsWith("name with spaces.sql"),
  "the production NUL parser preserves spaces and rejects mode 120000 even with a canonical filename; ls-files inventory has no rename-pair ambiguity",
);

const failed = checks.filter((check) => !check.passed);
const report = {
  verifier: "migration-chain-hardening",
  mode: "offline-static-only",
  passed: failed.length === 0,
  summary: {
    total: checks.length,
    passed: checks.length - failed.length,
    failed: failed.length,
  },
  checks,
};

console.log(JSON.stringify(report, null, 2));
if (failed.length > 0) process.exitCode = 1;
