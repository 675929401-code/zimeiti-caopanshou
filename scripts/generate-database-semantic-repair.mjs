#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import dotenv from "dotenv";
import pg from "pg";
import {
  DATABASE_SEMANTIC_SECTIONS,
  normalizeSemanticRow,
  objectKey,
  readSemanticRows,
  sha256,
  stableJson,
} from "./lib/database-semantic-catalog.mjs";

const { Client } = pg;
const args = process.argv.slice(2);
const root = path.resolve(valueOf("--root") || process.cwd());
const outputPath = path.resolve(
  root,
  valueOf("--output") || "deploy/database-repairs/20261009-production-semantic/20261009030000_database_semantic_contract_repair.sql",
);

dotenv.config({ path: path.join(root, ".env.local"), quiet: true });

function hasFlag(name) {
  return args.includes(name);
}

function valueOf(name) {
  const exact = args.find((argument) => argument.startsWith(`${name}=`));
  if (exact) return exact.slice(name.length + 1);
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : null;
}

function requireEnvironment(name) {
  const value = String(process.env[name] || "").trim();
  if (!value) throw new Error(`${name}_NOT_CONFIGURED`);
  return value;
}

function parsedDatabaseUrl(connectionString, label) {
  const parsed = new URL(connectionString);
  const database = decodeURIComponent(parsed.pathname.replace(/^\//u, ""));
  if (!database) throw new Error(`${label}_DATABASE_NAME_MISSING`);
  return { host: parsed.hostname.toLowerCase(), port: parsed.port || "5432", database };
}

function assertSafeTarget(referenceUrl, targetUrl) {
  const reference = parsedDatabaseUrl(referenceUrl, "REFERENCE");
  const target = parsedDatabaseUrl(targetUrl, "TARGET");
  if (reference.host === target.host && reference.port === target.port && reference.database === target.database) {
    throw new Error("REFERENCE_AND_TARGET_DATABASE_MUST_DIFFER");
  }
  const loopbackHosts = new Set(["127.0.0.1", "localhost", "::1"]);
  if (!loopbackHosts.has(target.host) && !hasFlag("--allow-remote-target")) {
    throw new Error("REMOTE_TARGET_REQUIRES_ALLOW_REMOTE_TARGET");
  }
  return { reference, target };
}

function assertPathInsideRoot(filePath) {
  const relative = path.relative(root, filePath);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("OUTPUT_PATH_OUTSIDE_PROJECT");
  }
}

function quoteIdentifier(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

function quoteLiteral(value) {
  if (value === null || value === undefined) return "NULL";
  return `'${String(value).replaceAll("'", "''")}'`;
}

function relationName(row) {
  return `${quoteIdentifier(row.schema_name)}.${quoteIdentifier(row.relation_name || row.object_name)}`;
}

function mapSection(rows, sectionName) {
  const section = DATABASE_SEMANTIC_SECTIONS.find((item) => item.name === sectionName);
  if (!section) throw new Error(`UNKNOWN_SECTION_${sectionName}`);
  return new Map((rows[sectionName] || []).map((row) => [objectKey(section, row), row]));
}

function rowsMissingFromTarget(referenceRows, targetRows, sectionName) {
  const target = mapSection(targetRows, sectionName);
  return [...mapSection(referenceRows, sectionName).entries()]
    .filter(([key]) => !target.has(key))
    .map(([, row]) => row);
}

function rowsChangedFromTarget(referenceRows, targetRows, sectionName) {
  const reference = mapSection(referenceRows, sectionName);
  const target = mapSection(targetRows, sectionName);
  return [...reference.entries()]
    .filter(([key, row]) => target.has(key)
      && stableJson(normalizeSemanticRow(sectionName, row))
        !== stableJson(normalizeSemanticRow(sectionName, target.get(key))))
    .map(([key, row]) => ({ key, reference: row, target: target.get(key) }));
}

function parsePgNameArray(value) {
  const text = String(value || "{}");
  if (text === "{}") return [];
  if (!text.startsWith("{") || !text.endsWith("}")) throw new Error("POLICY_ROLE_ARRAY_INVALID");
  const body = text.slice(1, -1);
  const values = [];
  let current = "";
  let quoted = false;
  for (let index = 0; index < body.length; index += 1) {
    const character = body[index];
    if (character === '"') {
      if (quoted && body[index + 1] === '"') {
        current += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (character === "," && !quoted) {
      values.push(current);
      current = "";
    } else {
      current += character;
    }
  }
  values.push(current);
  return values.filter(Boolean);
}

function withNotValid(definition) {
  if (/\bNOT\s+VALID\s*$/iu.test(definition)) return definition;
  return `${definition} NOT VALID`;
}

function createIndexIfMissing(definition) {
  const transformed = definition.replace(/^CREATE\s+(UNIQUE\s+)?INDEX\s+/iu, "CREATE $1INDEX IF NOT EXISTS ");
  if (transformed === definition) throw new Error("UNSUPPORTED_INDEX_DEFINITION");
  return `${transformed};`;
}

function renderPolicy(row) {
  const roles = parsePgNameArray(row.roles)
    .map((role) => role.toLowerCase() === "public" ? "PUBLIC" : quoteIdentifier(role))
    .join(", ") || "PUBLIC";
  const clauses = [
    `CREATE POLICY ${quoteIdentifier(row.policy_name)} ON ${relationName(row)}`,
    `  AS ${String(row.permissive).toUpperCase()}`,
    `  FOR ${String(row.cmd).toUpperCase()}`,
    `  TO ${roles}`,
  ];
  if (row.using_expression) clauses.push(`  USING (${row.using_expression})`);
  if (row.check_expression) clauses.push(`  WITH CHECK (${row.check_expression})`);
  return `${clauses.join("\n")};`;
}

function groupedGrants(rows, kind) {
  const groups = new Map();
  for (const row of rows) {
    const signature = kind === "FUNCTION"
      ? `${quoteIdentifier(row.schema_name)}.${quoteIdentifier(row.function_name)}(${row.identity_arguments})`
      : `${quoteIdentifier(row.schema_name)}.${quoteIdentifier(row.object_name)}`;
    const key = [signature, row.grantee, row.is_grantable === true].join("|");
    if (!groups.has(key)) groups.set(key, { signature, grantee: row.grantee, grantable: row.is_grantable === true, privileges: [] });
    groups.get(key).privileges.push(row.privilege_type);
  }
  return [...groups.values()]
    .sort((left, right) => `${left.signature}|${left.grantee}`.localeCompare(`${right.signature}|${right.grantee}`))
    .map((group) => `GRANT ${[...new Set(group.privileges)].sort().join(", ")} ON ${kind} ${group.signature} TO ${group.grantee === "PUBLIC" ? "PUBLIC" : quoteIdentifier(group.grantee)}${group.grantable ? " WITH GRANT OPTION" : ""};`);
}

function schemaGrants(rows) {
  const groups = new Map();
  for (const row of rows) {
    const key = [row.schema_name, row.grantee, row.is_grantable === true].join("|");
    if (!groups.has(key)) groups.set(key, { ...row, privileges: [] });
    groups.get(key).privileges.push(row.privilege_type);
  }
  return [...groups.values()]
    .sort((left, right) => `${left.schema_name}|${left.grantee}`.localeCompare(`${right.schema_name}|${right.grantee}`))
    .map((group) => `GRANT ${[...new Set(group.privileges)].sort().join(", ")} ON SCHEMA ${quoteIdentifier(group.schema_name)} TO ${group.grantee === "PUBLIC" ? "PUBLIC" : quoteIdentifier(group.grantee)}${group.is_grantable === true ? " WITH GRANT OPTION" : ""};`);
}

async function readFunctionDefinitions(client) {
  const result = await client.query(`select n.nspname as schema_name, p.proname as function_name,
      pg_catalog.pg_get_function_identity_arguments(p.oid) as identity_arguments,
      pg_catalog.pg_get_functiondef(p.oid) as definition
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
    order by p.proname, pg_catalog.pg_get_function_identity_arguments(p.oid)`);
  return new Map(result.rows.map((row) => [
    `${row.schema_name}|${row.function_name}|${row.identity_arguments}`,
    row.definition.trim().replace(/;?$/u, ";"),
  ]));
}

async function readIdentitySequences(client) {
  const result = await client.query(`select n.nspname as schema_name, c.relname as relation_name,
      a.attname as column_name, a.attidentity,
      seq_ns.nspname as sequence_schema, seq.relname as sequence_name,
      s.seqstart::text as start_value, s.seqincrement::text as increment_by,
      s.seqmin::text as min_value, s.seqmax::text as max_value,
      s.seqcache::text as cache_size, s.seqcycle as cycle
    from pg_attribute a
    join pg_class c on c.oid = a.attrelid
    join pg_namespace n on n.oid = c.relnamespace
    join pg_depend dep on dep.refobjid = c.oid and dep.refobjsubid = a.attnum and dep.deptype = 'i'
    join pg_class seq on seq.oid = dep.objid and seq.relkind = 'S'
    join pg_namespace seq_ns on seq_ns.oid = seq.relnamespace
    join pg_sequence s on s.seqrelid = seq.oid
    where n.nspname = 'public' and a.attidentity in ('a', 'd')
    order by c.relname, a.attname`);
  return new Map(result.rows.map((row) => [`${row.schema_name}|${row.relation_name}|${row.column_name}`, row]));
}

async function readTriggerColumnDependencies(client) {
  const result = await client.query(`select n.nspname as schema_name, c.relname as relation_name,
      t.tgname as trigger_name, pg_catalog.pg_get_triggerdef(t.oid, true) as definition,
      coalesce(array(
        select a.attname
        from unnest(t.tgattr::smallint[]) with ordinality dependency(attnum, position)
        join pg_attribute a on a.attrelid = t.tgrelid and a.attnum = dependency.attnum
        order by dependency.position
      ), array[]::name[]) as dependent_columns
    from pg_trigger t
    join pg_class c on c.oid = t.tgrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and not t.tgisinternal
    order by c.relname, t.tgname`);
  return result.rows;
}

function identityRepair(row, identity) {
  if (!identity) throw new Error(`IDENTITY_SEQUENCE_NOT_FOUND_${row.relation_name}_${row.column_name}`);
  const table = relationName(row);
  const column = quoteIdentifier(row.column_name);
  const sequence = `${quoteIdentifier(identity.sequence_schema)}.${quoteIdentifier(identity.sequence_name)}`;
  const generation = row.attidentity === "a" ? "ALWAYS" : "BY DEFAULT";
  return [
    `ALTER TABLE ${table} ALTER COLUMN ${column} DROP IDENTITY IF EXISTS;`,
    `DROP SEQUENCE IF EXISTS ${sequence};`,
    `ALTER TABLE ${table} ALTER COLUMN ${column} ADD GENERATED ${generation} AS IDENTITY (`,
    `  SEQUENCE NAME ${sequence}`,
    `  START WITH ${identity.start_value}`,
    `  INCREMENT BY ${identity.increment_by}`,
    `  MINVALUE ${identity.min_value}`,
    `  MAXVALUE ${identity.max_value}`,
    `  CACHE ${identity.cache_size}`,
    `  ${identity.cycle ? "CYCLE" : "NO CYCLE"}`,
    `);`,
    `SELECT pg_catalog.setval(${quoteLiteral(`${identity.sequence_schema}.${identity.sequence_name}`)}::regclass,`,
    `  COALESCE((SELECT max(${column})::bigint FROM ${table}), ${identity.start_value}::bigint),`,
    `  EXISTS (SELECT 1 FROM ${table}));`,
  ].join("\n");
}

function renderColumnRepair(change, identities) {
  const { reference, target } = change;
  const table = relationName(reference);
  const column = quoteIdentifier(reference.column_name);
  const statements = [];
  if (reference.attgenerated !== target.attgenerated) {
    if (reference.attgenerated !== "s" || target.attgenerated !== "") {
      throw new Error(`UNSUPPORTED_GENERATED_COLUMN_CHANGE_${reference.relation_name}_${reference.column_name}`);
    }
    statements.push(
      `ALTER TABLE ${table} DROP COLUMN ${column};`,
      `ALTER TABLE ${table} ADD COLUMN ${column} ${reference.data_type} GENERATED ALWAYS AS (${reference.default_expression}) STORED;`,
    );
    return statements;
  }
  if (reference.data_type !== target.data_type || reference.collation_name !== target.collation_name) {
    const collation = reference.collation_name ? ` COLLATE ${quoteIdentifier(reference.collation_name)}` : "";
    statements.push(`ALTER TABLE ${table} ALTER COLUMN ${column} TYPE ${reference.data_type}${collation} USING ${column}::${reference.data_type};`);
  }
  if (reference.attidentity !== target.attidentity) {
    if (!reference.attidentity) {
      statements.push(`ALTER TABLE ${table} ALTER COLUMN ${column} DROP IDENTITY IF EXISTS;`);
    } else {
      statements.push(identityRepair(reference, identities.get(change.key)));
    }
  }
  if (!reference.attidentity && reference.default_expression !== target.default_expression) {
    statements.push(reference.default_expression
      ? `ALTER TABLE ${table} ALTER COLUMN ${column} SET DEFAULT ${reference.default_expression};`
      : `ALTER TABLE ${table} ALTER COLUMN ${column} DROP DEFAULT;`);
  }
  if (reference.attnotnull !== target.attnotnull) {
    statements.push(`ALTER TABLE ${table} ALTER COLUMN ${column} ${reference.attnotnull ? "SET" : "DROP"} NOT NULL;`);
  }
  return statements;
}

function renderTableRepair(change) {
  const { reference, target } = change;
  const table = `${quoteIdentifier(reference.schema_name)}.${quoteIdentifier(reference.object_name)}`;
  const statements = [];
  if (reference.relkind !== target.relkind || reference.relpersistence !== target.relpersistence) {
    throw new Error(`UNSUPPORTED_TABLE_KIND_CHANGE_${reference.object_name}`);
  }
  if (reference.relrowsecurity !== target.relrowsecurity) {
    statements.push(`ALTER TABLE ${table} ${reference.relrowsecurity ? "ENABLE" : "DISABLE"} ROW LEVEL SECURITY;`);
  }
  if (reference.relforcerowsecurity !== target.relforcerowsecurity) {
    statements.push(`ALTER TABLE ${table} ${reference.relforcerowsecurity ? "FORCE" : "NO FORCE"} ROW LEVEL SECURITY;`);
  }
  if (reference.relreplident !== target.relreplident) {
    const modes = { d: "DEFAULT", n: "NOTHING", f: "FULL" };
    if (!modes[reference.relreplident]) throw new Error(`UNSUPPORTED_REPLICA_IDENTITY_${reference.object_name}`);
    statements.push(`ALTER TABLE ${table} REPLICA IDENTITY ${modes[reference.relreplident]};`);
  }
  return statements;
}

function buildMigration({ referenceRows, targetRows, functionDefinitions, identities, triggerDependencies, source, target }) {
  const lines = [
    "-- Generated by scripts/generate-database-semantic-repair.mjs.",
    "-- Restores reviewed database semantics without deleting business rows.",
    `-- Reference database: ${source.database}; target schema baseline: ${target.database}.`,
    "-- Apply to a full-data candidate first; any incompatible data aborts this transaction.",
    "BEGIN;",
    "SET LOCAL lock_timeout = '15s';",
    "SET LOCAL statement_timeout = '0';",
    "SET LOCAL search_path = public, pg_catalog;",
    "",
  ];
  const summary = {};

  const tableChanges = rowsChangedFromTarget(referenceRows, targetRows, "tables");
  summary.tableChanges = tableChanges.length;
  if (tableChanges.length) {
    lines.push("-- Table security and replication semantics.");
    for (const change of tableChanges) lines.push(...renderTableRepair(change));
    lines.push("");
  }

  const columnChanges = rowsChangedFromTarget(referenceRows, targetRows, "columns");
  summary.columnChanges = columnChanges.length;
  if (columnChanges.length) {
    const typeChangeKeys = new Set(columnChanges
      .filter((change) => change.reference.data_type !== change.target.data_type
        || change.reference.collation_name !== change.target.collation_name)
      .map((change) => `${change.reference.schema_name}|${change.reference.relation_name}|${change.reference.column_name}`));
    const impactedTriggers = triggerDependencies.filter((trigger) => {
      const columns = Array.isArray(trigger.dependent_columns)
        ? trigger.dependent_columns
        : parsePgNameArray(trigger.dependent_columns);
      return columns.some((column) => typeChangeKeys.has(`${trigger.schema_name}|${trigger.relation_name}|${column}`));
    });
    summary.temporarilyRecreatedTriggers = impactedTriggers.length;
    lines.push("-- Column types, defaults, identities, generated expressions, and nullability.");
    for (const trigger of impactedTriggers) {
      lines.push(`DROP TRIGGER ${quoteIdentifier(trigger.trigger_name)} ON ${relationName(trigger)};`);
    }
    if (impactedTriggers.length) lines.push("");
    for (const change of columnChanges) lines.push(...renderColumnRepair(change, identities), "");
    for (const trigger of impactedTriggers) lines.push(`${trigger.definition};`);
    if (impactedTriggers.length) lines.push("");
  }

  const missingConstraints = rowsMissingFromTarget(referenceRows, targetRows, "constraints");
  const changedConstraints = rowsChangedFromTarget(referenceRows, targetRows, "constraints");
  const validationOnly = [];
  const replacementConstraints = [];
  const unsupportedConstraintChanges = [];
  for (const change of changedConstraints) {
    const sameDefinition = change.reference.definition === change.target.definition
      && change.reference.contype === change.target.contype
      && change.reference.condeferrable === change.target.condeferrable
      && change.reference.condeferred === change.target.condeferred;
    if (sameDefinition && change.reference.convalidated === true && change.target.convalidated === false) {
      validationOnly.push(change.reference);
    } else if (["c", "f"].includes(change.reference.contype) && change.reference.contype === change.target.contype) {
      replacementConstraints.push(change.reference);
    } else {
      unsupportedConstraintChanges.push(change);
    }
  }
  if (unsupportedConstraintChanges.length) {
    throw new Error(`UNSUPPORTED_CHANGED_CONSTRAINTS_${unsupportedConstraintChanges.map((item) => item.key).join(",")}`);
  }
  summary.missingConstraints = missingConstraints.length;
  summary.replacedConstraints = replacementConstraints.length;
  summary.constraintsToValidate = validationOnly.length
    + missingConstraints.filter((row) => ["c", "f"].includes(row.contype)).length
    + replacementConstraints.length;
  if (missingConstraints.length || replacementConstraints.length || validationOnly.length) {
    lines.push("-- Missing constraints are added transactionally; checks and foreign keys validate real data before commit.");
    for (const row of replacementConstraints) {
      lines.push(`ALTER TABLE ${relationName(row)} DROP CONSTRAINT ${quoteIdentifier(row.constraint_name)};`);
    }
    const constraintPriority = new Map([["p", 0], ["u", 1], ["x", 2], ["c", 3], ["f", 4]]);
    const constraintsToAdd = [...missingConstraints, ...replacementConstraints].sort((left, right) => (
      (constraintPriority.get(left.contype) ?? 9) - (constraintPriority.get(right.contype) ?? 9)
      || `${left.relation_name}|${left.constraint_name}`.localeCompare(`${right.relation_name}|${right.constraint_name}`)
    ));
    for (const row of constraintsToAdd) {
      const definition = ["c", "f"].includes(row.contype) ? withNotValid(row.definition) : row.definition;
      lines.push(`ALTER TABLE ${relationName(row)} ADD CONSTRAINT ${quoteIdentifier(row.constraint_name)} ${definition};`);
    }
    for (const row of [
      ...missingConstraints.filter((item) => ["c", "f"].includes(item.contype)),
      ...replacementConstraints,
      ...validationOnly,
    ]) {
      lines.push(`ALTER TABLE ${relationName(row)} VALIDATE CONSTRAINT ${quoteIdentifier(row.constraint_name)};`);
    }
    lines.push("");
  }

  const missingIndexes = rowsMissingFromTarget(referenceRows, targetRows, "indexes");
  const changedIndexes = rowsChangedFromTarget(referenceRows, targetRows, "indexes");
  if (changedIndexes.length) throw new Error(`UNSUPPORTED_CHANGED_INDEXES_${changedIndexes.map((item) => item.key).join(",")}`);
  summary.missingIndexes = missingIndexes.length;
  if (missingIndexes.length) {
    lines.push("-- Supporting indexes absent from the target.");
    for (const row of missingIndexes) lines.push(createIndexIfMissing(row.definition));
    lines.push("");
  }

  const missingFunctions = rowsMissingFromTarget(referenceRows, targetRows, "functions");
  const changedFunctions = rowsChangedFromTarget(referenceRows, targetRows, "functions");
  if (changedFunctions.length) throw new Error(`UNSUPPORTED_CHANGED_FUNCTIONS_${changedFunctions.map((item) => item.key).join(",")}`);
  summary.missingFunctions = missingFunctions.length;
  if (missingFunctions.length) {
    lines.push("-- Canonical routines absent from the target.");
    for (const row of missingFunctions) {
      const key = `${row.schema_name}|${row.function_name}|${row.identity_arguments}`;
      const definition = functionDefinitions.get(key);
      if (!definition) throw new Error(`FUNCTION_DEFINITION_NOT_FOUND_${key}`);
      lines.push(definition, "");
    }
  }

  const missingPolicies = rowsMissingFromTarget(referenceRows, targetRows, "policies");
  const changedPolicies = rowsChangedFromTarget(referenceRows, targetRows, "policies");
  if (changedPolicies.length) throw new Error(`UNSUPPORTED_CHANGED_POLICIES_${changedPolicies.map((item) => item.key).join(",")}`);
  summary.missingPolicies = missingPolicies.length;
  if (missingPolicies.length) {
    lines.push("-- Row-level security policies absent from the target.");
    for (const row of missingPolicies) lines.push(renderPolicy(row));
    lines.push("");
  }

  summary.tablePrivilegeRows = referenceRows["table-privileges"].length;
  summary.sequencePrivilegeRows = referenceRows["sequence-privileges"].length;
  summary.functionPrivilegeRows = referenceRows["function-privileges"].length;
  summary.schemaPrivilegeRows = referenceRows["schema-privileges"].length;
  lines.push(
    "-- Remove accidental broad runtime grants, then restore the reviewed allow-list exactly.",
    "REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM PUBLIC, anon, authenticated, service_role;",
    "REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM PUBLIC, anon, authenticated, service_role;",
    "REVOKE ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC, anon, authenticated, service_role;",
    "REVOKE ALL PRIVILEGES ON SCHEMA public FROM PUBLIC, anon, authenticated, service_role;",
    ...groupedGrants(referenceRows["table-privileges"], "TABLE"),
    ...groupedGrants(referenceRows["sequence-privileges"], "SEQUENCE"),
    ...groupedGrants(referenceRows["function-privileges"], "FUNCTION"),
    ...schemaGrants(referenceRows["schema-privileges"]),
    "",
    "COMMIT;",
    "",
  );
  return { sql: lines.join("\n"), summary };
}

async function main() {
  const referenceUrl = requireEnvironment(valueOf("--reference-database-url-env") || "REFERENCE_DATABASE_URL");
  const targetUrl = requireEnvironment(valueOf("--target-database-url-env") || "TARGET_DATABASE_URL");
  const identities = assertSafeTarget(referenceUrl, targetUrl);
  const referenceClient = new Client({ connectionString: referenceUrl, application_name: "zimeiti-semantic-repair-reference" });
  const targetClient = new Client({ connectionString: targetUrl, application_name: "zimeiti-semantic-repair-target" });
  await Promise.all([referenceClient.connect(), targetClient.connect()]);
  try {
    const [referenceRows, targetRows] = await Promise.all([
      readSemanticRows(referenceClient),
      readSemanticRows(targetClient),
    ]);
    const functionDefinitions = await readFunctionDefinitions(referenceClient);
    const identitySequences = await readIdentitySequences(referenceClient);
    const triggerDependencies = await readTriggerColumnDependencies(targetClient);
    const generated = buildMigration({
      referenceRows,
      targetRows,
      functionDefinitions,
      identities: identitySequences,
      triggerDependencies,
      source: identities.reference,
      target: identities.target,
    });
    const result = {
      passed: true,
      mode: hasFlag("--write") ? "write" : "preview",
      output: path.relative(root, outputPath).split(path.sep).join("/"),
      sqlSha256: sha256(generated.sql),
      bytes: Buffer.byteLength(generated.sql),
      summary: generated.summary,
      databaseWrites: 0,
      paidModelCalls: 0,
      credentialsPrinted: false,
    };
    if (hasFlag("--write")) {
      assertPathInsideRoot(outputPath);
      if (fs.existsSync(outputPath) && !hasFlag("--replace")) throw new Error("OUTPUT_ALREADY_EXISTS");
      fs.mkdirSync(path.dirname(outputPath), { recursive: true });
      fs.writeFileSync(outputPath, generated.sql, "utf8");
    }
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await Promise.allSettled([referenceClient.end(), targetClient.end()]);
  }
}

main().catch((error) => {
  console.error(JSON.stringify({
    passed: false,
    code: error instanceof Error ? error.message.slice(0, 1000) : "UNKNOWN_ERROR",
    databaseWrites: 0,
    paidModelCalls: 0,
    credentialsPrinted: false,
  }, null, 2));
  process.exitCode = 1;
});
