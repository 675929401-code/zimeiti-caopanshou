import crypto from "node:crypto";

export const DATABASE_SEMANTIC_PROFILE = "public-runtime-contract.v1";

export function stableJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
}

export function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function normalizeSqlText(value) {
  if (typeof value !== "string" || !value) return value;
  const stringLiteral = "'(?:''|[^'])*'";
  return value
    .replace(new RegExp(`\\(\\s*(${stringLiteral})::character varying\\s*\\)::text`, "giu"), "$1")
    .replace(new RegExp(`(${stringLiteral})::character varying::text`, "giu"), "$1")
    .replace(new RegExp(`(${stringLiteral})::(?:character varying|text)`, "giu"), "$1")
    .replace(/::text\[\]/giu, "")
    .replace(new RegExp(`\\(\\s*(${stringLiteral})\\s*\\)`, "gu"), "$1")
    .replace(/\(\s*\((ARRAY\[[^\]]*\])\)\s*\)/giu, "($1)")
    .replace(/\s+/gu, " ")
    .trim();
}

export function normalizeSemanticRow(sectionName, row) {
  const normalized = { ...row };
  const sqlFields = new Set([
    "definition",
    "default_expression",
    "using_expression",
    "check_expression",
  ]);
  for (const field of sqlFields) {
    if (field in normalized) normalized[field] = normalizeSqlText(normalized[field]);
  }
  return normalized;
}

const sections = [
  {
    name: "tables",
    keys: ["schema_name", "object_name"],
    sql: `select n.nspname as schema_name, c.relname as object_name, c.relkind,
                 c.relpersistence, c.relrowsecurity, c.relforcerowsecurity, c.relreplident
            from pg_class c
            join pg_namespace n on n.oid = c.relnamespace
           where n.nspname = 'public' and c.relkind in ('r', 'p')
           order by c.relname`,
  },
  {
    name: "columns",
    keys: ["schema_name", "relation_name", "column_name"],
    sql: `select n.nspname as schema_name, c.relname as relation_name,
                 a.attname as column_name, pg_catalog.format_type(a.atttypid, a.atttypmod) as data_type,
                 a.attnotnull, a.attidentity, a.attgenerated,
                 coalesce(coll.collname, '') as collation_name,
                 coalesce(pg_catalog.pg_get_expr(ad.adbin, ad.adrelid, true), '') as default_expression
            from pg_attribute a
            join pg_class c on c.oid = a.attrelid
            join pg_namespace n on n.oid = c.relnamespace
       left join pg_attrdef ad on ad.adrelid = a.attrelid and ad.adnum = a.attnum
       left join pg_collation coll on coll.oid = a.attcollation
           where n.nspname = 'public' and c.relkind in ('r', 'p')
             and a.attnum > 0 and not a.attisdropped
           order by c.relname, a.attname`,
  },
  {
    name: "constraints",
    keys: ["schema_name", "relation_name", "constraint_name"],
    sql: `select n.nspname as schema_name, c.relname as relation_name, con.conname as constraint_name,
                 con.contype, con.condeferrable, con.condeferred, con.convalidated,
                 pg_catalog.pg_get_constraintdef(con.oid, true) as definition
            from pg_constraint con
            join pg_class c on c.oid = con.conrelid
            join pg_namespace n on n.oid = c.relnamespace
           where n.nspname = 'public'
           order by c.relname, con.conname`,
  },
  {
    name: "indexes",
    keys: ["schema_name", "relation_name", "index_name"],
    sql: `select schemaname as schema_name, tablename as relation_name,
                 indexname as index_name, indexdef as definition
            from pg_indexes
           where schemaname = 'public'
           order by tablename, indexname`,
  },
  {
    name: "functions",
    keys: ["schema_name", "function_name", "identity_arguments"],
    sql: `select n.nspname as schema_name, p.proname as function_name,
                 pg_catalog.pg_get_function_identity_arguments(p.oid) as identity_arguments,
                 pg_catalog.pg_get_function_result(p.oid) as result_type,
                 l.lanname as language_name, p.prokind, p.provolatile, p.proparallel,
                 p.prosecdef, p.proleakproof, p.proisstrict,
                 coalesce(p.proconfig::text, '') as configuration, p.prosrc as source
            from pg_proc p
            join pg_namespace n on n.oid = p.pronamespace
            join pg_language l on l.oid = p.prolang
           where n.nspname = 'public'
           order by p.proname, pg_catalog.pg_get_function_identity_arguments(p.oid)`,
  },
  {
    name: "policies",
    keys: ["schema_name", "relation_name", "policy_name"],
    sql: `select schemaname as schema_name, tablename as relation_name, policyname as policy_name,
                 permissive, roles::text, cmd,
                 coalesce(qual, '') as using_expression,
                 coalesce(with_check, '') as check_expression
            from pg_policies
           where schemaname = 'public'
           order by tablename, policyname`,
  },
  {
    name: "triggers",
    keys: ["schema_name", "relation_name", "trigger_name"],
    sql: `select n.nspname as schema_name, c.relname as relation_name,
                 t.tgname as trigger_name, t.tgenabled,
                 pg_catalog.pg_get_triggerdef(t.oid, true) as definition
            from pg_trigger t
            join pg_class c on c.oid = t.tgrelid
            join pg_namespace n on n.oid = c.relnamespace
           where n.nspname = 'public' and not t.tgisinternal
           order by c.relname, t.tgname`,
  },
  {
    name: "sequences",
    keys: ["schema_name", "sequence_name"],
    sql: `select schemaname as schema_name, sequencename as sequence_name,
                 data_type, start_value::text, min_value::text, max_value::text,
                 increment_by::text, cycle, cache_size::text
            from pg_sequences
           where schemaname = 'public'
           order by sequencename`,
  },
  {
    name: "views",
    keys: ["schema_name", "view_name"],
    sql: `select schemaname as schema_name, viewname as view_name, definition
            from pg_views
           where schemaname = 'public'
           order by viewname`,
  },
  {
    name: "enum-values",
    keys: ["schema_name", "type_name", "sort_order"],
    sql: `select n.nspname as schema_name, t.typname as type_name,
                 e.enumsortorder::text as sort_order, e.enumlabel
            from pg_enum e
            join pg_type t on t.oid = e.enumtypid
            join pg_namespace n on n.oid = t.typnamespace
           where n.nspname = 'public'
           order by t.typname, e.enumsortorder`,
  },
  {
    name: "table-privileges",
    keys: ["schema_name", "object_name", "grantee", "privilege_type"],
    exactExtras: true,
    sql: `select n.nspname as schema_name, c.relname as object_name,
                 case when acl.grantee = 0 then 'PUBLIC' else pg_catalog.pg_get_userbyid(acl.grantee) end as grantee,
                 acl.privilege_type, acl.is_grantable
            from pg_class c
            join pg_namespace n on n.oid = c.relnamespace
      cross join lateral aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) acl
           where n.nspname = 'public' and c.relkind in ('r', 'p')
             and (acl.grantee = 0 or pg_catalog.pg_get_userbyid(acl.grantee) in ('anon', 'authenticated', 'service_role'))
           order by c.relname, grantee, acl.privilege_type`,
  },
  {
    name: "sequence-privileges",
    keys: ["schema_name", "object_name", "grantee", "privilege_type"],
    exactExtras: true,
    sql: `select n.nspname as schema_name, c.relname as object_name,
                 case when acl.grantee = 0 then 'PUBLIC' else pg_catalog.pg_get_userbyid(acl.grantee) end as grantee,
                 acl.privilege_type, acl.is_grantable
            from pg_class c
            join pg_namespace n on n.oid = c.relnamespace
      cross join lateral aclexplode(coalesce(c.relacl, acldefault('S', c.relowner))) acl
           where n.nspname = 'public' and c.relkind = 'S'
             and (acl.grantee = 0 or pg_catalog.pg_get_userbyid(acl.grantee) in ('anon', 'authenticated', 'service_role'))
           order by c.relname, grantee, acl.privilege_type`,
  },
  {
    name: "function-privileges",
    keys: ["schema_name", "function_name", "identity_arguments", "grantee", "privilege_type"],
    exactExtras: true,
    sql: `select n.nspname as schema_name, p.proname as function_name,
                 pg_catalog.pg_get_function_identity_arguments(p.oid) as identity_arguments,
                 case when acl.grantee = 0 then 'PUBLIC' else pg_catalog.pg_get_userbyid(acl.grantee) end as grantee,
                 acl.privilege_type, acl.is_grantable
            from pg_proc p
            join pg_namespace n on n.oid = p.pronamespace
      cross join lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) acl
           where n.nspname = 'public'
             and (acl.grantee = 0 or pg_catalog.pg_get_userbyid(acl.grantee) in ('anon', 'authenticated', 'service_role'))
           order by p.proname, pg_catalog.pg_get_function_identity_arguments(p.oid), grantee, acl.privilege_type`,
  },
  {
    name: "schema-privileges",
    keys: ["schema_name", "grantee", "privilege_type"],
    exactExtras: true,
    sql: `select n.nspname as schema_name,
                 case when acl.grantee = 0 then 'PUBLIC' else pg_catalog.pg_get_userbyid(acl.grantee) end as grantee,
                 acl.privilege_type, acl.is_grantable
            from pg_namespace n
      cross join lateral aclexplode(coalesce(n.nspacl, acldefault('n', n.nspowner))) acl
           where n.nspname = 'public'
             and (acl.grantee = 0 or pg_catalog.pg_get_userbyid(acl.grantee) in ('anon', 'authenticated', 'service_role'))
           order by grantee, acl.privilege_type`,
  },
];

export const DATABASE_SEMANTIC_SECTIONS = Object.freeze(sections);

export function objectKey(section, row) {
  return section.keys.map((field) => String(row[field] ?? "")).join("|");
}

export async function readSemanticRows(client) {
  const result = {};
  for (const section of sections) {
    const query = await client.query(section.sql);
    result[section.name] = query.rows;
  }
  return result;
}

export function semanticSnapshotFromRows(rowsBySection) {
  const normalizedSections = {};
  for (const section of sections) {
    const rows = rowsBySection[section.name] || [];
    const objects = rows.map((row) => ({
      key: objectKey(section, row),
      sha256: sha256(stableJson(normalizeSemanticRow(section.name, row))),
    }));
    normalizedSections[section.name] = {
      rows: rows.length,
      sha256: sha256(stableJson(objects)),
      exactExtras: section.exactExtras === true,
      objects,
    };
  }
  return {
    profile: DATABASE_SEMANTIC_PROFILE,
    sections: normalizedSections,
    sha256: sha256(stableJson(normalizedSections)),
  };
}

export async function captureSemanticSnapshot(client) {
  return semanticSnapshotFromRows(await readSemanticRows(client));
}

export function compareSemanticSnapshots(expected, actual, { strictExtras = false } = {}) {
  const differences = [];
  const sectionNames = new Set([
    ...Object.keys(expected?.sections || {}),
    ...Object.keys(actual?.sections || {}),
  ]);
  for (const sectionName of [...sectionNames].sort()) {
    const expectedSection = expected?.sections?.[sectionName] || { objects: [] };
    const actualSection = actual?.sections?.[sectionName] || { objects: [] };
    const expectedObjects = new Map((expectedSection.objects || []).map((item) => [item.key, item.sha256]));
    const actualObjects = new Map((actualSection.objects || []).map((item) => [item.key, item.sha256]));
    for (const key of [...new Set([...expectedObjects.keys(), ...actualObjects.keys()])].sort()) {
      const expectedSha256 = expectedObjects.get(key) || null;
      const actualSha256 = actualObjects.get(key) || null;
      if (expectedSha256 === actualSha256) continue;
      const kind = expectedSha256 === null ? "extra" : actualSha256 === null ? "missing" : "changed";
      const blocking = kind !== "extra" || strictExtras || expectedSection.exactExtras === true;
      differences.push({ section: sectionName, key, kind, blocking, expectedSha256, actualSha256 });
    }
  }
  return {
    passed: differences.every((item) => !item.blocking),
    blocking: differences.filter((item) => item.blocking),
    warnings: differences.filter((item) => !item.blocking),
    differences,
  };
}
