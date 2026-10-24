import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { InvalidImageFileError, validateImageFile } from "../src/lib/image-file-validation";

async function main() {
  // Use a repository-owned icon by default. The old golden-media paths lived
  // in an expired temporary evidence bundle and made this contract fail with
  // ENOENT before it could test validation semantics.
  const validPath = process.env.VALID_IMAGE_PATH || "src/app/icon.png";
  const valid = validateImageFile(await readFile(validPath), "image/png");
  assert.equal(valid.format, "png");
  assert.ok((valid.width || 0) > 0 && (valid.height || 0) > 0);

  const corruptBytes = Buffer.from("not-an-image", "utf8");
  assert.throws(
    () => validateImageFile(corruptBytes, "image/png"),
    (error) => error instanceof InvalidImageFileError && error.code === "IMAGE_DECODE_FAILED",
  );

  console.log(JSON.stringify({ passed: true, valid, corruptRejected: true }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
