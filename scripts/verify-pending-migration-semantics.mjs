#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import dotenv from "dotenv";
import pg from "pg";

const { Client } = pg;
const root = process.cwd();
const migrationRoot = path.join(root, "supabase", "migrations");
const policy = JSON.parse(fs.readFileSync(path.join(root, "deploy", "policies", "release-policy.json"), "utf8"));
const excluded = new Set(policy.database?.excludedForwardMigrations || []);
const writeEvidence = process.argv.includes("--write-evidence");
const evidenceRoot = path.join(root, ".codex-evidence", "db-migration-release");
const CHECK_VERSION = "pending-migration-object-coverage.v1";

dotenv.config({ path: path.join(root, ".env.local"), quiet: true });

const PROFILES = [
  "20260825123000_manju_config_control_plane.sql",
  "20260825173500_voice_atomic_authorization_purchase.sql",
  "20260827093000_skill_packages_runtime.sql",
  "20260829223000_manju_config_storage_state.sql",
  "20260902134000_skill_next_draft_cas.sql",
  "20260903021000_image_model_validation_governance.sql",
  "20260903074000_llm_stream_credit_reservations.sql",
  "20260903153500_video_fractional_duration.sql",
  "20260903212000_digital_video_dispatch_queue.sql",
];

const REQUIRED_EXTERNAL_COLUMNS = {
  "20260903074000_llm_stream_credit_reservations.sql": [
    { table: "users", column: "credits_reserved", dataType: "numeric(20,6)", notNull: true, defaultRequired: true },
  ],
  "20260903153500_video_fractional_duration.sql": [
    { table: "video_tasks", column: "duration_seconds", dataType: "numeric(12,3)", notNull: null, defaultRequired: null },
  ],
};

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function stableJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
}

function splitSqlStatements(sql) {
  const statements = [];
  let start = 0;
  let single = false;
  let double = false;
  let lineComment = false;
  let blockComment = false;
  let dollarTag = null;
  for (let index = 0; index < sql.length; index += 1) {
    const char = sql[index];
    const next = sql[index + 1];
    if (lineComment) {
      if (char === "\n") lineComment = false;
      continue;
    }
    if (blockComment) {
      if (char === "*" && next === "/") {
        blockComment = false;
        index += 1;
      }
      continue;
    }
    if (dollarTag) {
      if (sql.startsWith(dollarTag, index)) {
        index += dollarTag.length - 1;
        dollarTag = null;
      }
      continue;
    }
    if (single) {
      if (char === "'" && next === "'") index += 1;
      else if (char === "'") single = false;
      continue;
    }
    if (double) {
      if (char === '"' && next === '"') index += 1;
      else if (char === '"') double = false;
      continue;
    }
    if (char === "-" && next === "-") {
      lineComment = true;
      index += 1;
      continue;
    }
    if (char === "/" && next === "*") {
      blockComment = true;
      index += 1;
      continue;
    }
    if (char === "'") {
      single = true;
      continue;
    }
    if (char === '"') {
      double = true;
      continue;
    }
    if (char === "$") {
      const match = sql.slice(index).match(/^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/u);
      if (match) {
        dollarTag = match[0];
        index += dollarTag.length - 1;
        continue;
      }
    }
    if (char === ";") {
      statements.push(sql.slice(start, index + 1).trim());
      start = index + 1;
    }
  }
  const tail = sql.slice(start).trim();
  if (tail) statements.push(tail);
  return statements.filter(Boolean);
}

function findClosingParen(text, openIndex) {
  let depth = 0;
  let single = false;
  let double = false;
  for (let index = openIndex; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];
    if (single) {
      if (char === "'" && next === "'") index += 1;
      else if (char === "'") single = false;
      continue;
    }
    if (double) {
      if (char === '"' && next === '"') index += 1;
      else if (char === '"') double = false;
      continue;
    }
    if (char === "'") single = true;
    else if (char === '"') double = true;
    else if (char === "(") depth += 1;
    else if (char === ")") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function splitTopLevelComma(text) {
  const parts = [];
  let start = 0;
  let depth = 0;
  let single = false;
  let double = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];
    if (single) {
      if (char === "'" && next === "'") index += 1;
      else if (char === "'") single = false;
      continue;
    }
    if (double) {
      if (char === '"' && next === '"') index += 1;
      else if (char === '"') double = false;
      continue;
    }
    if (char === "'") single = true;
    else if (char === '"') double = true;
    else if (char === "(") depth += 1;
    else if (char === ")") depth -= 1;
    else if (char === "," && depth === 0) {
      parts.push(text.slice(start, index).trim());
      start = index + 1;
    }
  }
  parts.push(text.slice(start).trim());
  return parts.filter(Boolean);
}

function normalizeWhitespace(value) {
  return String(value || "").replace(/\r\n?/gu, "\n").split("\n").map((line) => line.trimEnd()).join("\n").trim();
}

function parseColumnEntry(entry, enforced = true) {
  if (/^(?:CONSTRAINT|PRIMARY|UNIQUE|CHECK|FOREIGN|EXCLUDE)\b/iu.test(entry)) return null;
  const columnMatch = entry.match(/^"?([A-Za-z0-9_]+)"?\s+([\s\S]+)$/u);
  if (!columnMatch) return null;
  const rest = columnMatch[2];
  const boundary = rest.search(/\s+(?:COLLATE|DEFAULT|NOT\s+NULL|NULL|CONSTRAINT|PRIMARY\s+KEY|UNIQUE|CHECK|REFERENCES|GENERATED)\b/iu);
  const typeSource = boundary < 0 ? rest : rest.slice(0, boundary);
  return {
    name: columnMatch[1].toLowerCase(),
    dataType: normalizeType(typeSource),
    notNull: /\bNOT\s+NULL\b|\bPRIMARY\s+KEY\b/iu.test(rest),
    defaultRequired: /\bDEFAULT\b/iu.test(rest) || /\b(?:BIG)?SERIAL\b/iu.test(typeSource),
    enforced,
  };
}

function normalizeType(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/"/gu, "")
    .replace(/\bpublic\./gu, "")
    .replace(/\btimestamptz\b/gu, "timestamp with time zone")
    .replace(/\btimestampz\b/gu, "timestamp with time zone")
    .replace(/\bint8\b|\bbigserial\b/gu, "bigint")
    .replace(/\bint4\b|\bserial\b/gu, "integer")
    .replace(/\bint2\b/gu, "smallint")
    .replace(/\bbool\b/gu, "boolean")
    .replace(/\bcharacter varying\b/gu, "varchar")
    .replace(/\s*,\s*/gu, ",")
    .replace(/\s+/gu, " ")
    .trim();
}

function stripDefault(parameter) {
  let depth = 0;
  let single = false;
  for (let index = 0; index < parameter.length; index += 1) {
    const char = parameter[index];
    const next = parameter[index + 1];
    if (single) {
      if (char === "'" && next === "'") index += 1;
      else if (char === "'") single = false;
      continue;
    }
    if (char === "'") single = true;
    else if (char === "(") depth += 1;
    else if (char === ")") depth -= 1;
    if (depth === 0 && /^\s+default\s+/iu.test(parameter.slice(index))) return parameter.slice(0, index).trim();
  }
  return parameter.trim();
}

function normalizeIdentityArguments(value) {
  if (!String(value || "").trim()) return "";
  return splitTopLevelComma(value).map((parameter) => normalizeType(stripDefault(parameter))).join(", ");
}

function parseFunctionStatement(statement, sourceFile) {
  const match = statement.match(/\bCREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+public\."?([A-Za-z0-9_]+)"?\s*\(/iu);
  if (!match) return null;
  const openIndex = statement.indexOf("(", match.index + match[0].length - 1);
  const closeIndex = findClosingParen(statement, openIndex);
  if (closeIndex < 0) throw new Error(`FUNCTION_SIGNATURE_PARSE_FAILED:${sourceFile}:${match[1]}`);
  const delimiterMatch = statement.slice(closeIndex + 1).match(/\bAS\s+(\$[A-Za-z_][A-Za-z0-9_]*\$|\$\$)/iu);
  if (!delimiterMatch) throw new Error(`FUNCTION_BODY_PARSE_FAILED:${sourceFile}:${match[1]}`);
  const delimiter = delimiterMatch[1];
  const bodyStart = closeIndex + 1 + delimiterMatch.index + delimiterMatch[0].length;
  const bodyEnd = statement.indexOf(delimiter, bodyStart);
  if (bodyEnd < 0) throw new Error(`FUNCTION_BODY_TERMINATOR_MISSING:${sourceFile}:${match[1]}`);
  const language = statement.match(/\bLANGUAGE\s+([A-Za-z0-9_]+)/iu)?.[1]?.toLowerCase() || null;
  const searchPath = statement.match(/\bSET\s+search_path\s*(?:=|TO)\s*([\s\S]*?)(?=\s+AS\s+(?:\$[A-Za-z_][A-Za-z0-9_]*\$|\$\$)|[\r\n;])/iu)?.[1]
    ?.split(",").map((item) => item.trim().replace(/^['"]|['"]$/gu, "").toLowerCase()).join(", ") || "";
  return {
    name: match[1].toLowerCase(),
    identityArguments: normalizeIdentityArguments(statement.slice(openIndex + 1, closeIndex)),
    language,
    securityDefiner: /\bSECURITY\s+DEFINER\b/iu.test(statement),
    searchPath,
    bodySha256: sha256(normalizeWhitespace(statement.slice(bodyStart, bodyEnd))),
    sourceFile,
  };
}

function parseCreatedTable(statement, sourceFile) {
  const match = statement.match(/\bCREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?public\."?([A-Za-z0-9_]+)"?\s*\(/iu);
  if (!match) return null;
  const openIndex = statement.indexOf("(", match.index + match[0].length - 1);
  const closeIndex = findClosingParen(statement, openIndex);
  if (closeIndex < 0) throw new Error(`TABLE_DEFINITION_PARSE_FAILED:${sourceFile}:${match[1]}`);
  const conditional = /\bCREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\b/iu.test(statement);
  const columns = [];
  const constraints = [];
  for (const entry of splitTopLevelComma(statement.slice(openIndex + 1, closeIndex))) {
    const constraint = entry.match(/^CONSTRAINT\s+"?([A-Za-z0-9_]+)"?\s+([\s\S]+)$/iu);
    if (constraint) {
      constraints.push({ name: constraint[1].toLowerCase(), sourceSha256: sha256(normalizeWhitespace(constraint[2]).toLowerCase()) });
      continue;
    }
    const column = parseColumnEntry(entry, !conditional);
    if (column) columns.push(column);
  }
  return { name: match[1].toLowerCase(), columns, constraints, sourceFile, conditional };
}

function applyAlterTableExpectation(statement, tableDefinitions) {
  const match = statement.match(/\bALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?public\."?([A-Za-z0-9_]+)"?\s+([\s\S]+)$/iu);
  if (!match) return;
  const table = tableDefinitions.get(match[1].toLowerCase());
  if (!table) return;
  const action = match[2].replace(/;\s*$/u, "").trim();
  const actions = splitTopLevelComma(action);
  if (actions.length > 1) {
    for (const item of actions) applyAlterTableExpectation(`ALTER TABLE public.${table.name} ${item};`, tableDefinitions);
    return;
  }
  const add = action.match(/^ADD\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?([\s\S]+)$/iu);
  if (add) {
    const column = parseColumnEntry(add[1], true);
    if (column) {
      const index = table.columns.findIndex((item) => item.name === column.name);
      if (index >= 0) table.columns[index] = column;
      else table.columns.push(column);
    }
    return;
  }
  const type = action.match(/^ALTER\s+COLUMN\s+"?([A-Za-z0-9_]+)"?\s+TYPE\s+([\s\S]+?)(?=\s+USING\s+|$)/iu);
  if (type) {
    const column = table.columns.find((item) => item.name === type[1].toLowerCase());
    if (column) {
      column.dataType = normalizeType(type[2]);
      column.enforced = true;
    }
    return;
  }
  const nullability = action.match(/^ALTER\s+COLUMN\s+"?([A-Za-z0-9_]+)"?\s+(SET|DROP)\s+NOT\s+NULL$/iu);
  if (nullability) {
    const column = table.columns.find((item) => item.name === nullability[1].toLowerCase());
    if (column) {
      column.notNull = nullability[2].toUpperCase() === "SET";
      column.enforced = true;
    }
    return;
  }
  const defaultChange = action.match(/^ALTER\s+COLUMN\s+"?([A-Za-z0-9_]+)"?\s+(SET\s+DEFAULT|DROP\s+DEFAULT)\b/iu);
  if (defaultChange) {
    const column = table.columns.find((item) => item.name === defaultChange[1].toLowerCase());
    if (column) {
      column.defaultRequired = /^SET/iu.test(defaultChange[2]);
      column.enforced = true;
    }
  }
}

function sourceObjectNames(sql, expression) {
  return [...sql.matchAll(expression)].map((match) => match[1].toLowerCase());
}

function releaseMigrationFiles() {
  return fs.readdirSync(migrationRoot)
    .filter((name) => /^\d{14}_[a-z0-9_-]+\.sql$/iu.test(name) && !excluded.has(name))
    .sort();
}

function readMigration(name) {
  return fs.readFileSync(path.join(migrationRoot, name), "utf8");
}

function buildSourceModel() {
  const latestFunctions = new Map();
  const latestFunctionsByName = new Map();
  const tableDefinitions = new Map();
  const migrationTexts = new Map();
  for (const file of releaseMigrationFiles()) {
    const sql = readMigration(file);
    migrationTexts.set(file, sql);
    for (const statement of splitSqlStatements(sql)) {
      const fn = parseFunctionStatement(statement, file);
      if (fn) {
        latestFunctions.set(`${fn.name}|${fn.identityArguments}`, fn);
        latestFunctionsByName.set(fn.name, fn);
      }
      const table = parseCreatedTable(statement, file);
      if (table && !tableDefinitions.has(table.name)) tableDefinitions.set(table.name, table);
      applyAlterTableExpectation(statement, tableDefinitions);
    }
  }
  return { latestFunctions, latestFunctionsByName, tableDefinitions, migrationTexts };
}

function databaseUrl() {
  for (const name of policy.database?.migrationDatabaseUrlEnv || ["DEPLOY_DATABASE_URL"]) {
    const value = String(process.env[name] || "").trim();
    if (value) return { name, value };
  }
  throw new Error("DEPLOY_DATABASE_URL_NOT_CONFIGURED");
}

function safeTarget(connectionString) {
  const parsed = new URL(connectionString);
  const host = parsed.hostname.toLowerCase();
  if (!["127.0.0.1", "localhost", "::1", "[::1]"].includes(host)) throw new Error("NON_LOCAL_DATABASE_READ_REFUSED");
  return { host, port: parsed.port || "5432" };
}

function check(name, passed, evidence = {}) {
  return { name, passed: Boolean(passed), ...evidence };
}

async function readTable(client, name) {
  const table = await client.query(`
    select c.oid::text as oid, c.relrowsecurity,
           exists(select 1 from aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a where a.grantee = 0) as public_privileges,
           has_table_privilege('anon', c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') as anon_privileges,
           has_table_privilege('authenticated', c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') as authenticated_privileges,
           has_table_privilege('service_role', c.oid, 'SELECT') as service_select
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relname = $1 and c.relkind in ('r', 'p')`, [name]);
  if (table.rowCount === 0) return null;
  const columns = await client.query(`
    select a.attname as name, format_type(a.atttypid, a.atttypmod) as data_type,
           a.attnotnull as not_null,
           pg_get_expr(d.adbin, d.adrelid, true) as default_expression
      from pg_attribute a
 left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
     where a.attrelid = $1::oid and a.attnum > 0 and not a.attisdropped
     order by a.attnum`, [table.rows[0].oid]);
  return { ...table.rows[0], columns: columns.rows };
}

async function readFunction(client, expected) {
  const result = await client.query(`
    select p.oid::text as oid,
           pg_get_function_identity_arguments(p.oid) as identity_arguments,
           l.lanname as language_name,
           p.prosecdef,
           coalesce(array_to_string(p.proconfig, ','), '') as configuration,
           p.prosrc,
           exists(select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a where a.grantee = 0 and a.privilege_type = 'EXECUTE') as public_execute,
           has_function_privilege('anon', p.oid, 'EXECUTE') as anon_execute,
           has_function_privilege('authenticated', p.oid, 'EXECUTE') as authenticated_execute,
           has_function_privilege('service_role', p.oid, 'EXECUTE') as service_execute
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      join pg_language l on l.oid = p.prolang
     where n.nspname = 'public' and p.proname = $1
     order by pg_get_function_identity_arguments(p.oid)`, [expected.name]);
  return result.rows.find((row) => normalizeIdentityArguments(row.identity_arguments) === expected.identityArguments) || null;
}

async function objectExists(client, kind, name) {
  if (kind === "index") {
    const result = await client.query(`
      select pg_get_indexdef(c.oid) as definition, i.indisunique
        from pg_class c join pg_namespace n on n.oid = c.relnamespace
        join pg_index i on i.indexrelid = c.oid
       where n.nspname = 'public' and c.relname = $1`, [name]);
    return result.rows[0] || null;
  }
  if (kind === "trigger") {
    const result = await client.query(`
      select pg_get_triggerdef(t.oid, true) as definition
        from pg_trigger t join pg_class c on c.oid = t.tgrelid
        join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and t.tgname = $1 and not t.tgisinternal`, [name]);
    return result.rows[0] || null;
  }
  if (kind === "policy") {
    const result = await client.query(`
      select schemaname, tablename, policyname, permissive, roles::text, cmd,
             coalesce(qual, '') as using_expression, coalesce(with_check, '') as check_expression
        from pg_policies where schemaname = 'public' and policyname = $1`, [name]);
    return result.rows[0] || null;
  }
  if (kind === "constraint") {
    const result = await client.query(`
      select c.relname as relation_name, con.contype, con.convalidated,
             pg_get_constraintdef(con.oid, true) as definition
        from pg_constraint con join pg_class c on c.oid = con.conrelid
        join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and con.conname = $1`, [name]);
    return result.rows[0] || null;
  }
  throw new Error(`UNSUPPORTED_OBJECT_KIND:${kind}`);
}

function expectedServiceExecution(name, allSql) {
  return new RegExp(`GRANT\\s+EXECUTE\\s+ON\\s+FUNCTION[^;]*public\\.${name}\\s*\\(`, "iu").test(allSql);
}

function sourceProfile(file, sourceModel) {
  const sql = sourceModel.migrationTexts.get(file);
  if (!sql) throw new Error(`PROFILE_SOURCE_MISSING:${file}`);
  const statements = splitSqlStatements(sql);
  const functions = statements.map((statement) => parseFunctionStatement(statement, file)).filter(Boolean);
  const tableNames = sourceObjectNames(sql, /\bCREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?public\."?([A-Za-z0-9_]+)"?/giu);
  const indexNames = sourceObjectNames(sql, /\bCREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?"?([A-Za-z0-9_]+)"?/giu);
  const triggerNames = sourceObjectNames(sql, /\bCREATE\s+(?:OR\s+REPLACE\s+)?TRIGGER\s+"?([A-Za-z0-9_]+)"?/giu);
  const policyNames = sourceObjectNames(sql, /\bCREATE\s+POLICY\s+"?([A-Za-z0-9_]+)"?/giu);
  const constraintNames = [...new Set([
    ...tableNames.flatMap((name) => sourceModel.tableDefinitions.get(name)?.constraints.map((item) => item.name) || []),
    ...statements.map((statement) => statement.match(/\bALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?public\.[A-Za-z0-9_]+\s+ADD\s+CONSTRAINT\s+"?([A-Za-z0-9_]+)"?/iu)?.[1]?.toLowerCase()).filter(Boolean),
  ])];
  const rlsTables = sourceObjectNames(sql, /\bALTER\s+TABLE\s+public\."?([A-Za-z0-9_]+)"?\s+ENABLE\s+ROW\s+LEVEL\s+SECURITY/giu);
  return { file, sql, functions, tableNames, indexNames, triggerNames, policyNames, constraintNames, rlsTables };
}

async function verifyProfile(client, profile, sourceModel, allSql) {
  const checks = [];
  for (const tableName of profile.tableNames) {
    const expected = sourceModel.tableDefinitions.get(tableName);
    const live = await readTable(client, tableName);
    checks.push(check(`table:${tableName}:exists`, Boolean(live), live ? { catalogSha256: sha256(stableJson(live)) } : {}));
    if (!live || !expected) continue;
    const liveColumns = new Map(live.columns.map((column) => [column.name, column]));
    for (const column of expected.columns.filter((item) => item.enforced !== false)) {
      const current = liveColumns.get(column.name);
      checks.push(check(`table:${tableName}:column:${column.name}`, Boolean(current)
        && normalizeType(current.data_type) === column.dataType
        && Boolean(current.not_null) === column.notNull
        && Boolean(current.default_expression) === column.defaultRequired, {
        expectedType: column.dataType,
        currentType: current ? normalizeType(current.data_type) : null,
        expectedNotNull: column.notNull,
        currentNotNull: current?.not_null ?? null,
        expectedDefault: column.defaultRequired,
        currentDefault: current ? Boolean(current.default_expression) : null,
      }));
    }
    if (profile.rlsTables.includes(tableName)) checks.push(check(`table:${tableName}:rls`, live.relrowsecurity === true));
    const accessWasRevoked = new RegExp(`REVOKE\\s+ALL\\s+ON(?:\\s+TABLE)?\\s+public\\.${tableName}\\s+FROM[^;]*(?:anon|authenticated)`, "iu").test(profile.sql);
    if (accessWasRevoked) {
      checks.push(check(`table:${tableName}:anon-denied`, live.anon_privileges === false));
      checks.push(check(`table:${tableName}:authenticated-denied`, live.authenticated_privileges === false));
    }
    const publicWasRevoked = new RegExp(`REVOKE\\s+ALL\\s+ON(?:\\s+TABLE)?\\s+public\\.${tableName}\\s+FROM[^;]*PUBLIC`, "iu").test(profile.sql);
    if (publicWasRevoked) checks.push(check(`table:${tableName}:public-denied`, live.public_privileges === false));
  }

  for (const requirement of REQUIRED_EXTERNAL_COLUMNS[profile.file] || []) {
    const table = await readTable(client, requirement.table);
    const column = table?.columns.find((item) => item.name === requirement.column);
    const passed = Boolean(column)
      && normalizeType(column.data_type) === requirement.dataType
      && (requirement.notNull === null || Boolean(column.not_null) === requirement.notNull)
      && (requirement.defaultRequired === null || Boolean(column.default_expression) === requirement.defaultRequired);
    checks.push(check(`external-column:${requirement.table}.${requirement.column}`, passed, {
      expectedType: requirement.dataType,
      currentType: column ? normalizeType(column.data_type) : null,
      currentNotNull: column?.not_null ?? null,
      currentDefault: column ? Boolean(column.default_expression) : null,
    }));
  }

  for (const original of profile.functions) {
    const expected = sourceModel.latestFunctionsByName.get(original.name) || null;
    const key = expected ? `${expected.name}|${expected.identityArguments}` : `${original.name}|${original.identityArguments}`;
    const live = expected ? await readFunction(client, expected) : null;
    const obsolete = expected && expected.identityArguments !== original.identityArguments ? await readFunction(client, original) : null;
    const expectedService = expected ? expectedServiceExecution(expected.name, allSql) : false;
    const liveSearchPath = String(live?.configuration || "").replace(/^search_path=/u, "").split(",").map((item) => item.trim().toLowerCase()).filter(Boolean).join(", ");
    checks.push(check(`function:${key}:latest-source-resolved`, Boolean(expected), { expectedSourceFile: expected?.sourceFile || null }));
    checks.push(check(`function:${key}:exists`, Boolean(live)));
    if (expected && expected.identityArguments !== original.identityArguments) {
      checks.push(check(`function:${original.name}|${original.identityArguments}:superseded-signature-absent`, obsolete === null, {
        replacementSignature: expected.identityArguments,
        replacementSourceFile: expected.sourceFile,
      }));
    }
    if (!expected || !live) continue;
    checks.push(check(`function:${key}:body`, sha256(normalizeWhitespace(live.prosrc)) === expected.bodySha256, {
      expectedSha256: expected.bodySha256,
      currentSha256: sha256(normalizeWhitespace(live.prosrc)),
      expectedSourceFile: expected.sourceFile,
    }));
    checks.push(check(`function:${key}:language`, live.language_name === expected.language, { expected: expected.language, current: live.language_name }));
    checks.push(check(`function:${key}:security-definer`, live.prosecdef === expected.securityDefiner, { expected: expected.securityDefiner, current: live.prosecdef }));
    checks.push(check(`function:${key}:search-path`, liveSearchPath === expected.searchPath, { expected: expected.searchPath, current: liveSearchPath }));
    checks.push(check(`function:${key}:public-denied`, live.public_execute === false));
    checks.push(check(`function:${key}:anon-denied`, live.anon_execute === false));
    checks.push(check(`function:${key}:authenticated-denied`, live.authenticated_execute === false));
    if (expectedService) checks.push(check(`function:${key}:service-role-execute`, live.service_execute === true));
  }

  for (const kind of ["index", "trigger", "policy", "constraint"]) {
    const names = profile[`${kind}Names`] || [];
    for (const name of names) {
      const live = await objectExists(client, kind, name);
      checks.push(check(`${kind}:${name}:exists`, Boolean(live), live ? { catalogSha256: sha256(stableJson(live)) } : {}));
    }
  }
  return {
    version: profile.file.slice(0, 14),
    file: profile.file,
    sourceSha256: sha256(profile.sql),
    passed: checks.every((item) => item.passed),
    passedChecks: checks.filter((item) => item.passed).length,
    totalChecks: checks.length,
    failed: checks.filter((item) => !item.passed),
    checks,
  };
}

async function main() {
  const sourceModel = buildSourceModel();
  const allSql = [...sourceModel.migrationTexts.values()].join("\n");
  const profiles = PROFILES.map((file) => sourceProfile(file, sourceModel));
  const config = databaseUrl();
  const target = safeTarget(config.value);
  const client = new Client({ connectionString: config.value, application_name: "codex-pending-migration-readonly-verifier" });
  let transactionOpen = false;
  await client.connect();
  let results;
  let targetFingerprint;
  try {
    await client.query("begin read only");
    transactionOpen = true;
    await client.query("set local statement_timeout = '30s'");
    await client.query("set local lock_timeout = '5s'");
    const identity = await client.query(`select current_database() as database_name, current_setting('server_version_num') as server_version, coalesce(inet_server_addr()::text, 'local') as server_address, coalesce(inet_server_port()::text, 'local') as server_port`);
    targetFingerprint = sha256(stableJson({ configuredHost: target.host, ...identity.rows[0] }));
    results = [];
    for (const profile of profiles) results.push(await verifyProfile(client, profile, sourceModel, allSql));
    await client.query("rollback");
    transactionOpen = false;
  } finally {
    if (transactionOpen) {
      try { await client.query("rollback"); } catch { /* read-only connection closes below */ }
    }
    await client.end();
  }
  const core = {
    schemaVersion: 1,
    kind: "pending-migration-semantic-coverage-receipt",
    semanticCheckVersion: CHECK_VERSION,
    generatedAt: new Date().toISOString(),
    targetClass: "local-loopback-only",
    targetHost: target.host,
    targetFingerprint,
    profileCount: results.length,
    passedProfiles: results.filter((item) => item.passed).length,
    blockedProfiles: results.filter((item) => !item.passed).length,
    results,
    databaseWrites: 0,
    migrationLedgerWrites: 0,
    paidModelCalls: 0,
    credentialsPrinted: false,
  };
  const receipt = { ...core, receiptSha256: sha256(stableJson(core)) };
  let evidence = null;
  if (writeEvidence) {
    fs.mkdirSync(evidenceRoot, { recursive: true });
    const stamp = receipt.generatedAt.replace(/[:.]/gu, "-");
    const evidencePath = path.join(evidenceRoot, `${stamp}-pending-semantic-coverage.json`);
    const evidenceBody = `${JSON.stringify(receipt, null, 2)}\n`;
    fs.writeFileSync(evidencePath, evidenceBody, "utf8");
    evidence = {
      path: path.relative(root, evidencePath).replaceAll("\\", "/"),
      fileSha256: sha256(evidenceBody),
    };
  }
  console.log(JSON.stringify({
    ok: receipt.blockedProfiles === 0,
    kind: receipt.kind,
    semanticCheckVersion: receipt.semanticCheckVersion,
    targetClass: receipt.targetClass,
    targetHost: receipt.targetHost,
    targetFingerprint: receipt.targetFingerprint,
    profileCount: receipt.profileCount,
    passedProfiles: receipt.passedProfiles,
    blockedProfiles: receipt.blockedProfiles,
    results: receipt.results.map((item) => ({
      version: item.version,
      file: item.file,
      sourceSha256: item.sourceSha256,
      passed: item.passed,
      passedChecks: item.passedChecks,
      totalChecks: item.totalChecks,
      failed: item.failed,
    })),
    databaseWrites: receipt.databaseWrites,
    migrationLedgerWrites: receipt.migrationLedgerWrites,
    paidModelCalls: receipt.paidModelCalls,
    credentialsPrinted: receipt.credentialsPrinted,
    receiptSha256: receipt.receiptSha256,
    evidence,
  }, null, 2));
  process.exitCode = receipt.blockedProfiles === 0 ? 0 : 1;
}

main().catch((error) => {
  const code = String(error?.message || "PENDING_MIGRATION_SEMANTIC_CHECK_FAILED").replace(/[^A-Za-z0-9_.:-]/gu, "_").slice(0, 160);
  console.error(JSON.stringify({ ok: false, error: code, databaseWrites: 0, credentialsPrinted: false }));
  process.exitCode = 1;
});
