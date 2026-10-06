import assert from "node:assert/strict";
import { parseSingleByteRange } from "../src/lib/http-byte-range";

const size = 1_000;
const cases: Array<[string | null, ReturnType<typeof parseSingleByteRange>]> = [
  [null, null],
  ["bytes=0-99", { start: 0, end: 99 }],
  ["bytes=900-", { start: 900, end: 999 }],
  ["bytes=-100", { start: 900, end: 999 }],
  ["bytes=-2000", { start: 0, end: 999 }],
  ["bytes=950-2000", { start: 950, end: 999 }],
  ["bytes=1000-", "invalid"],
  ["bytes=200-100", "invalid"],
  ["bytes=0-1,4-5", "invalid"],
  ["items=0-99", "invalid"],
  ["bytes=-0", "invalid"],
  ["bytes=-", "invalid"],
];

for (const [header, expected] of cases) {
  assert.deepEqual(parseSingleByteRange(header, size), expected, `unexpected range result for ${header}`);
}
assert.equal(parseSingleByteRange("bytes=0-1", 0), "invalid");
assert.equal(parseSingleByteRange("bytes=0-1", Number.NaN), "invalid");

console.log(JSON.stringify({ passed: true, scenarios: cases.length + 2, multipartRanges: "rejected" }));
