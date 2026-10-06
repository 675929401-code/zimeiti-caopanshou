import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";

type Check = {
  name: string;
  passed: boolean;
  detail: string;
};

const root = process.cwd();
const checks: Check[] = [];

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
const migrationNames = existsSync(migrationsDirectory) ? readdirSync(migrationsDirectory) : [];
const misplacedRollbacks = migrationNames.filter((name) => name.endsWith(".rollback.sql"));
add(
  "migration-directory:no-rollbacks",
  misplacedRollbacks.length === 0,
  misplacedRollbacks.length === 0 ? "no rollback SQL in forward directory" : misplacedRollbacks.join(", "),
);

const versions = migrationNames
  .map((name) => /^(\d{14})_[a-z0-9_]+\.sql$/u.exec(name)?.[1])
  .filter((version): version is string => Boolean(version));
const duplicateVersions = [...new Set(versions.filter((version, index) => versions.indexOf(version) !== index))];
add(
  "migration-directory:unique-versions",
  duplicateVersions.length === 0,
  duplicateVersions.length === 0 ? "all 14-digit versions unique" : duplicateVersions.join(", "),
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
