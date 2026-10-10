import assert from "node:assert/strict";
import { createHash } from "node:crypto";

const sha256 = value => createHash("sha256").update(value).digest("hex");
const normalizeBody = value => String(value || "").replace(/\r\n?/gu, "\n").trim();

export function extractPgFunctionBody(definition) {
  const text = String(definition || "").replace(/\r\n?/gu, "\n");
  const opening = /\bAS\s+(\$[A-Za-z0-9_]*\$)/iu.exec(text);
  assert.ok(opening, "PG_GET_FUNCTIONDEF_BODY_START_MISSING");
  const marker = opening[1];
  const bodyStart = opening.index + opening[0].length;
  const bodyEnd = text.indexOf(marker, bodyStart);
  assert.ok(bodyEnd >= bodyStart, "PG_GET_FUNCTIONDEF_BODY_END_MISSING");
  return normalizeBody(text.slice(bodyStart, bodyEnd));
}

function migrationFunctionBlock(source, name) {
  const start = source.indexOf(`CREATE OR REPLACE FUNCTION public.${name}`);
  assert.ok(start >= 0, `MIGRATION_FUNCTION_SOURCE_MISSING:${name}`);
  const next = source.indexOf("CREATE OR REPLACE FUNCTION public.", start + 1);
  const end = next >= 0 ? next : source.length;
  const block = source.slice(start, end);
  const headerEnd = block.indexOf("AS $$");
  const bodyEnd = block.indexOf("$$;", headerEnd + 5);
  assert.ok(headerEnd >= 0 && bodyEnd > headerEnd, `MIGRATION_FUNCTION_BODY_MISSING:${name}`);
  return { header: block.slice(0, headerEnd), body: normalizeBody(block.slice(headerEnd + 5, bodyEnd)) };
}

function sourceConfig(header) {
  const searchPath = /\bSET\s+search_path\s*=\s*([^\n\r]+)/iu.exec(header)?.[1]
    ?.split(",").map(value => value.trim().replace(/^['"]|['"]$/gu, "")).join(", ");
  return searchPath ? [`search_path=${searchPath}`] : [];
}

export function expectedFunctionSemanticDescriptor(source, name) {
  const { header, body } = migrationFunctionBlock(source, name);
  const normalizedHeader = header.replace(/\s+/gu, " ").trim();
  const argumentsText = new RegExp(`FUNCTION\\s+public\\.${name}\\(([^)]*)\\)`, "iu").exec(normalizedHeader)?.[1]?.trim();
  const result = /\bRETURNS\s+([^ ]+)/iu.exec(normalizedHeader)?.[1]?.toLowerCase();
  const language = /\bLANGUAGE\s+([^ ]+)/iu.exec(normalizedHeader)?.[1]?.toLowerCase();
  assert.ok(argumentsText && result && language, `MIGRATION_FUNCTION_HEADER_INCOMPLETE:${name}`);
  return {
    identityArguments: argumentsText,
    result,
    language,
    volatility: /\bIMMUTABLE\b/iu.test(header) ? "i" : /\bSTABLE\b/iu.test(header) ? "s" : "v",
    strict: /\bSTRICT\b|\bRETURNS NULL ON NULL INPUT\b/iu.test(header),
    parallel: /\bPARALLEL\s+SAFE\b/iu.test(header) ? "s" : /\bPARALLEL\s+RESTRICTED\b/iu.test(header) ? "r" : "u",
    leakproof: /\bLEAKPROOF\b/iu.test(header),
    kind: /\bPROCEDURE\b/iu.test(header) ? "p" : "f",
    returnsSet: /\bRETURNS\s+(?:SETOF|TABLE\b)/iu.test(header),
    securityDefiner: /\bSECURITY\s+DEFINER\b/iu.test(header),
    cost: Number(/\bCOST\s+([0-9.]+)/iu.exec(header)?.[1] || 100),
    rows: Number(/\bROWS\s+([0-9.]+)/iu.exec(header)?.[1] || 0),
    support: /\bSUPPORT\s+([^\s]+)/iu.exec(header)?.[1] || "-",
    config: sourceConfig(header),
    bodyHash: sha256(body),
  };
}

export function liveFunctionSemanticDescriptor(row) {
  assert.ok(row?.function_definition, "PG_GET_FUNCTIONDEF_REQUIRED");
  return {
    identityArguments: String(row.identity_arguments || ""),
    result: String(row.result || "").toLowerCase(),
    language: String(row.language || "").toLowerCase(),
    volatility: String(row.volatility || ""),
    strict: row.strict === true,
    parallel: String(row.parallel || ""),
    leakproof: row.leakproof === true,
    kind: String(row.kind || ""),
    returnsSet: row.returns_set === true,
    securityDefiner: row.security_definer === true,
    cost: Number(row.cost),
    rows: Number(row.rows),
    support: String(row.support || "-"),
    config: [...(row.config || [])].map(String).sort(),
    bodyHash: sha256(extractPgFunctionBody(row.function_definition)),
  };
}

export function functionSemanticHash(descriptor) {
  const canonical = {
    ...descriptor,
    config: [...descriptor.config].map(String).sort(),
  };
  return sha256(JSON.stringify(canonical));
}

export function normalizeUnexpectedExecuteRoles(value) {
  if (Array.isArray(value)) return value.map(String).filter(Boolean).sort();
  if (value === null || value === undefined) return ["__ACL_RESULT_MISSING__"];
  const text = String(value).trim();
  if (text === "{}" || text === "[]") return [];
  if (text.startsWith("[")) {
    try {
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed)) return parsed.map(String).filter(Boolean).sort();
    } catch { /* fail closed below */ }
  }
  return [`__ACL_RESULT_UNPARSEABLE__:${text}`];
}

export function functionAclAssessment(row) {
  const unexpectedRoles = normalizeUnexpectedExecuteRoles(row?.unexpected_roles);
  const serviceExecute = row?.service_execute === true;
  const anonExecute = row?.anon_execute === true;
  const authenticatedExecute = row?.authenticated_execute === true;
  return {
    serviceExecute,
    anonExecute,
    authenticatedExecute,
    unexpectedRoles,
    serviceOnly: serviceExecute && !anonExecute && !authenticatedExecute && unexpectedRoles.length === 0,
  };
}
