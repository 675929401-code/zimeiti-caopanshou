import pg from "pg";

const parseTextArray = pg.types.getTypeParser(1009, "text");

export function normalizePgTextArray(value) {
  if (value == null) return [];
  if (Array.isArray(value)) return value.map(item => String(item));
  if (typeof value !== "string") {
    throw new TypeError("POSTGRES_TEXT_ARRAY_REQUIRED");
  }
  const parsed = parseTextArray(value);
  if (!Array.isArray(parsed)) {
    throw new TypeError("POSTGRES_TEXT_ARRAY_PARSE_FAILED");
  }
  return parsed.map(item => String(item));
}

export function evaluateFunctionAcl(row, serviceCallable) {
  const unexpectedRoles = normalizePgTextArray(row?.unexpected_roles);
  const serviceExecute = row?.service_execute === true;
  const anonExecute = row?.anon_execute === true;
  const authenticatedExecute = row?.authenticated_execute === true;
  return {
    serviceExecute,
    anonExecute,
    authenticatedExecute,
    unexpectedRoles,
    serviceOnly: serviceExecute === serviceCallable
      && !anonExecute
      && !authenticatedExecute
      && unexpectedRoles.length === 0,
  };
}
