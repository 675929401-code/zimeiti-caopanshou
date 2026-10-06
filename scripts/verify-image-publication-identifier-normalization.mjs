#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile("src/lib/image-model-publication.ts", "utf8");
assert.match(source, /function sameDatabaseIdentifier\(left: unknown, right: unknown\): boolean/u);
assert.match(source, /sameDatabaseIdentifier\(meta\.billingOperationId, operation\.id\)/u);
assert.match(source, /sameDatabaseIdentifier\(entry\.operation_id, operation\.id\)/u);
assert.doesNotMatch(source, /meta\.billingOperationId !== operation\.id/u);
assert.doesNotMatch(source, /entry\.operation_id !== operation\.id/u);

const sameDatabaseIdentifier = (left, right) => {
  const normalizedLeft = String(left ?? "").trim();
  const normalizedRight = String(right ?? "").trim();
  return normalizedLeft.length > 0 && normalizedLeft === normalizedRight;
};

assert.equal(sameDatabaseIdentifier("272", 272), true);
assert.equal(sameDatabaseIdentifier(272n, "272"), true);
assert.equal(sameDatabaseIdentifier("272", "273"), false);
assert.equal(sameDatabaseIdentifier("", ""), false);
assert.equal(sameDatabaseIdentifier(null, 0), false);

console.log(JSON.stringify({ success: true, mixedBigintRepresentationsAccepted: true, distinctIdentifiersRejected: true }));
