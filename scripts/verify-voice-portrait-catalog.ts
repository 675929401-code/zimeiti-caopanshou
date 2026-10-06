import assert from "node:assert/strict";
import sharp from "sharp";
import { OFFICIAL_VOICES } from "../src/lib/vs/voices-data";
import { isChineseVoice } from "../src/lib/vs/voice-curation";
import { getVoicePortraitPosition } from "../src/lib/vs/avatar";

async function main() {
const atlasPath = "public/avatars/voice-studio/portraits.webp";
const metadata = await sharp(atlasPath).metadata();
assert.equal(metadata.format, "webp", "portrait atlas must be a WebP");
const width = Number(metadata.width);
const height = Number(metadata.height);
assert.ok(width >= 800 && height >= 600, "portrait atlas resolution is too small");

const voices = OFFICIAL_VOICES.filter(isChineseVoice);
assert.equal(voices.length, OFFICIAL_VOICES.length, "catalog must contain only Chinese voices");
assert.ok(voices.length > 100, "catalog is unexpectedly incomplete");
const usedPositions = new Set<string>();
for (const voice of voices) {
  assert.ok(voice.gender === "male" || voice.gender === "female", `${voice.speakerId} has no usable gender mapping`);
  const position = getVoicePortraitPosition(voice.speakerId, voice.name, voice.gender);
  assert.ok(Number.isInteger(position.row) && position.row >= 0 && position.row <= 2, `${voice.speakerId} has an invalid portrait row`);
  assert.ok(Number.isInteger(position.column) && position.column >= 0 && position.column <= 3, `${voice.speakerId} has an invalid portrait column`);
  const childOrTeen = /童|萌娃|奶气|小孩|正太|萝莉|萌宝|奶萌|娃娃|稚嫩|小朋友|小奶音|少年|少女/.test(voice.name);
  if (childOrTeen) assert.equal(position.row, 2, `${voice.name} must use a youth portrait`);
  else assert.equal(position.row, voice.gender === "male" ? 1 : 0, `${voice.name} portrait gender does not match`);
  usedPositions.add(`${position.row}:${position.column}`);
}

console.log(JSON.stringify({
  status: "passed", voices: voices.length, atlas: { path: atlasPath, width, height },
  genders: {
    female: voices.filter((voice) => voice.gender === "female").length,
    male: voices.filter((voice) => voice.gender === "male").length,
  },
  portraitVariantsUsed: usedPositions.size,
}, null, 2));
}

void main();
