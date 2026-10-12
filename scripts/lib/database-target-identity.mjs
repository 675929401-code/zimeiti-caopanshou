import crypto from "node:crypto";

// Compatibility identity for this runner, not a physical cluster/account proof.
// No environment access, connection creation, or CLI side effects on import.
export async function readDatabaseTargetIdentity(client, configuredHost) {
  const result = await client.query(`
    select current_database() as database_name,
           current_setting('server_version_num') as server_version,
           coalesce(inet_server_addr()::text, 'local') as server_address,
           coalesce(inet_server_port()::text, 'local') as server_port
  `);
  const row = result.rows[0] || {};
  if (typeof configuredHost !== "string" || !configuredHost
    || ![row.database_name, row.server_version, row.server_address, row.server_port].every((value) => typeof value === "string" && value.length > 0)) {
    throw new Error("DATABASE_TARGET_IDENTITY_INCOMPLETE");
  }
  // Keep the original stableJson's alphabetic key order and exact five values.
  const core = { configuredHost, databaseName: row.database_name, serverAddress: row.server_address,
    serverPort: row.server_port, serverVersion: row.server_version };
  return { fingerprint: crypto.createHash("sha256").update(JSON.stringify(core)).digest("hex"), ...core };
}
