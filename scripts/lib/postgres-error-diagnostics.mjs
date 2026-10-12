// Pure projection: caller must authenticate the actual PostgreSQL error constructor.
import crypto from "node:crypto";
export function postgresErrorDiagnostics(error, isPostgresError) {
  if (isPostgresError !== true) return undefined;
  const sha256 = value => crypto.createHash("sha256").update(value).digest("hex");
  const result = {};
  if (typeof error.code === "string" && /^[A-Z0-9]{5}$/u.test(error.code) && !error.code.startsWith("00")) result.sqlState = error.code;
  const position = typeof error.position === "number" ? error.position
    : typeof error.position === "string" && /^[0-9]+$/u.test(error.position) ? Number(error.position) : NaN;
  if (Number.isSafeInteger(position) && position > 0) result.position = position;
  if (typeof error.message === "string") result.messageSha256 = sha256(error.message);
  for (const field of ["schema", "table", "constraint"]) {
    if (typeof error[field] === "string") result[`${field}Sha256`] = sha256(error[field]);
  }
  return result;
}
