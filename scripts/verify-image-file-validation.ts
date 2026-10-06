import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { InvalidImageFileError, validateImageFile } from "../src/lib/image-file-validation";

async function main() {
  const validPath = process.env.VALID_IMAGE_PATH || ".tmp-e2e/three-directors-golden-v53-media/01-故事版导演-高能夸张.png";
  const corruptPath = process.env.CORRUPT_IMAGE_PATH || ".tmp-e2e/three-directors-golden-v53-media/03-source-redownload.png";
  const valid = validateImageFile(await readFile(validPath), "image/png");
  assert.equal(valid.format, "png");
  assert.ok((valid.width || 0) > 0 && (valid.height || 0) > 0);

  const corruptBytes = await readFile(corruptPath);
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
