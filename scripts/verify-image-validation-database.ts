import assert from "node:assert/strict";
import { assertImageValidationDatabase, assertImageValidationAdministrator, ImageAdminValidationError } from "../src/lib/image-admin-validation";

type Database = Parameters<typeof assertImageValidationDatabase>[0];
const database = (url: string) => ({ supabaseUrl: url }) as Database;
for (const url of ["http://127.0.0.1:54321", "https://configured-database.example.com"]) {
  assert.doesNotThrow(() => assertImageValidationDatabase(database(url)));
}
const embeddedCredentials = new URL("https://database.example.com");
embeddedCredentials.username = "fixture-user";
embeddedCredentials.password = "fixture-value";
for (const url of ["", "file:///database", "ftp://database.example.com", embeddedCredentials.href, "https://database.example.com/rest/v1", "https://database.example.com?key=value", "https://database.example.com/#fragment"]) {
  assert.throws(() => assertImageValidationDatabase(database(url)), (error: unknown) => error instanceof ImageAdminValidationError && error.code === "IMAGE_VALIDATION_DATABASE_UNAVAILABLE");
}
assert.throws(() => assertImageValidationAdministrator({ ok: false, error: "Unauthorized", code: "UNAUTHORIZED", status: 401 }), (error: unknown) => error instanceof ImageAdminValidationError && error.status === 401);
console.log(JSON.stringify({ status: "PASS", configuredDatabaseOrigins: 2, malformedDatabaseOriginsRejected: 7, administratorAuthorizationPreserved: true }));
