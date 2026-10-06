import assert from "node:assert/strict";
import { fetchRemoteImageDimensions } from "../src/lib/image-dimensions";

const url = "https://source.openclaw-token.shop/uploads/1786782883-5f67449adce8.png";

async function main() {
  const dimensions = await fetchRemoteImageDimensions(url);
  assert.deepEqual(dimensions, { width: 2560, height: 1440 });
  console.log(JSON.stringify({
    result: "PASS",
    paid_generation_requests: 0,
    dimension_source: "remote-file-header",
    dimensions,
  }, null, 2));
}

void main();
