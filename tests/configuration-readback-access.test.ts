import test from "node:test";
import assert from "node:assert/strict";
import { adminRequirementForRequest } from "../src/lib/admin-governance";

for (const path of ["/api/admin/formal-catalog-preview", "/api/admin/configuration-identity"]) {
  test(`${path} only maps the exact read route before its owner check`, () => {
    assert.equal(adminRequirementForRequest(path, "GET")?.permission, "agents.view");
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      assert.notEqual(adminRequirementForRequest(path, method)?.operation, "configuration_readback");
    }
    assert.notEqual(adminRequirementForRequest(`${path}/extra`, "GET")?.operation, "configuration_readback");
  });
}
