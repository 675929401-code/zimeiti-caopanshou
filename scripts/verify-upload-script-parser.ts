import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { strToU8, zipSync } from "fflate";
import {
  parseUploadedScriptFile,
  UploadScriptError,
} from "../src/lib/short-drama/upload-script";

const txt = parseUploadedScriptFile({
  filename: "demo.txt",
  bytes: strToU8("第1集\r\n[1] 内 客厅 日\r\n人物：小林\r\n小林：「开始吧。」"),
});
assert.equal(txt.extension, "txt");
assert.match(txt.text, /第1集\n\[1\]/);

const docx = zipSync({
  "[Content_Types].xml": strToU8("<Types/>"),
  "word/document.xml": strToU8(
    '<w:document xmlns:w="urn:test"><w:body><w:p><w:r><w:t>第一场 &amp; 开始</w:t></w:r></w:p><w:p><w:r><w:t>第二段</w:t></w:r></w:p></w:body></w:document>',
  ),
});
const parsedDocx = parseUploadedScriptFile({ filename: "demo.docx", bytes: docx });
assert.equal(parsedDocx.extension, "docx");
assert.equal(parsedDocx.text, "第一场 & 开始\n第二段");

assert.throws(
  () => parseUploadedScriptFile({ filename: "bad.pdf", bytes: strToU8("x") }),
  (error: unknown) => error instanceof UploadScriptError && error.code === "FILE_TYPE_UNSUPPORTED",
);

const workbenchSource = readFileSync(
  new URL("../src/features/upload-script/upload-script-workbench.tsx", import.meta.url),
  "utf8",
);
const standardizeRouteSource = readFileSync(
  new URL("../src/app/api/short-drama/upload-script/standardize/route.ts", import.meta.url),
  "utf8",
);

assert.match(workbenchSource, /type Genre = "drama" \| "short" \| "formal";/);
assert.match(workbenchSource, /formal:\s*\{[\s\S]*?profileId: "formal-drama-upload",[\s\S]*?summaryGenre: "正剧",[\s\S]*?videoSize: "16:9",[\s\S]*?aspectRatio: "16:9",[\s\S]*?animationStyle: "传统影视正剧",/);
assert.match(workbenchSource, /setGenre\("formal"\)/);
assert.match(workbenchSource, /<strong>正剧<\/strong>/);
assert.match(standardizeRouteSource, /z\.enum\(\["drama", "short", "formal"\]\)/);
assert.match(standardizeRouteSource, /formal: "正剧"/);

console.log(JSON.stringify({
  ok: true,
  txtChars: txt.chars,
  docxChars: parsedDocx.chars,
  uploadGenres: ["drama", "short", "formal"],
}));
