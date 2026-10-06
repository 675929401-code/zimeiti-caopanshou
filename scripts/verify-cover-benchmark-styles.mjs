import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import vm from "node:vm";
import sharp from "sharp";
import ts from "typescript";

const nativeRequire = createRequire(import.meta.url);
function load(path) {
  const context = {
    exports: {}, Buffer, console,
    require: (name) => nativeRequire(name),
  };
  vm.runInNewContext(ts.transpileModule(readFileSync(path, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText, context, { filename: path });
  return context.exports;
}

const pure = load("src/lib/cover-composition.ts");
const renderer = load("src/lib/cover-composition-server.ts");
assert.equal(renderer.COVER_COMPOSITION_VERSION, "cover-composition-v2");
assert.ok(renderer.coverCompositionFont("story-cartoon"));
assert.ok(renderer.coverCompositionFont("funny-cartoon"));
assert.ok(renderer.coverCompositionFont("reference-adaptive"));

const prompt = pure.buildCoverBackgroundPrompt({
  brief: "小狗在门口等主人回家",
  visualStyle: "暖色情绪叙事",
  layoutHint: "主体位于中下部",
  coverModeId: "cartoon",
  materialSourceId: "template",
});
assert.match(prompt, /不能生成空白文字框、黑色横条、白色底栏/u);
assert.match(prompt, /连续场景或自然纹理/u);
assert.match(prompt, /不得出现汉字、英文字母、数字、标点符号/u);
assert.doesNotMatch(prompt, /上方约30%留出干净背景/u);

assert.deepEqual([...renderer.coverTitleLines("它忘了很多，却没忘你", "3:4")].length, 2);
assert.equal(renderer.coverTitleLines("狗狗主动邀玩的三个动作，你能看懂几个，很多人都误会了", "3:4").length, 3);
assert.equal(renderer.coverTitleLines("狗狗咧嘴\n是在笑吗?", "9:16").length, 2);

const componentSource = readFileSync("src/components/cover-studio.tsx", "utf8");
const cssSource = readFileSync("src/app/cover/cover-studio-v2.css", "utf8");
const routeSource = readFileSync("src/app/api/cover/render/route.ts", "utf8");
for (const token of ["coverModeId, materialSourceId", "subjectModeId:", "cover-stage-mode-${previewModeId}", "previewSourceId === \"template\""]) {
  assert.ok(componentSource.includes(token), `component contract missing: ${token}`);
}
for (const token of ["coverModeId: z.enum", "materialSourceId: z.enum", "subjectModeId: z.enum", "compositionProfile"]) {
  assert.ok(routeSource.includes(token), `route contract missing: ${token}`);
}
for (const token of [
  'html[data-theme="lattice"] .cover-rebuild-shell .cover-rebuild-stage',
  'html[data-theme="crystal-aurora"]',
  'html[data-theme="soft-white"][data-mode="light"] .cover-rebuild-shell .cover-rebuild-stage',
  ".cover-stage-mode-funny-cartoon",
  ".cover-stage-source-template",
]) assert.ok(cssSource.includes(token), `theme stage contract missing: ${token}`);

const directory = ".codex-evidence/cover-benchmark-style-20260928";
mkdirSync(directory, { recursive: true });
const ratios = {
  "3:4": [1200, 1600],
  "9:16": [900, 1600],
  "4:3": [1600, 1200],
  "16:9": [1600, 900],
};
const profiles = [
  {
    key: "story",
    expected: "story-cartoon",
    title: "它忘了很多\n却没忘你",
    subtitle: "每次等门，都是一次想念",
    coverModeId: "cartoon",
    materialSourceId: "text",
    layoutTemplateId: "gaoding-real-12",
  },
  {
    key: "funny",
    expected: "funny-cartoon",
    title: "狗狗这个表情\n到底几个意思?",
    subtitle: "先看表情，再揭开它的小心思",
    coverModeId: "funny-cartoon",
    materialSourceId: "text",
    layoutTemplateId: "gaoding-real-12",
  },
  {
    key: "reference",
    expected: "reference-adaptive",
    title: "狗狗主动邀玩的3个动作\n你能看懂几个?",
    subtitle: "动作里藏着邀请暗号",
    coverModeId: "cartoon",
    materialSourceId: "template",
    layoutTemplateId: "gaoding-teacher-interview",
  },
];

const cells = [];
const results = [];
for (const profile of profiles) {
  for (const [ratio, [width, height]] of Object.entries(ratios)) {
    const background = await sharp(Buffer.from(`<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="g" x2="1" y2="1"><stop stop-color="#315b70"/><stop offset=".52" stop-color="#b66a49"/><stop offset="1" stop-color="#382849"/></linearGradient></defs><rect width="100%" height="100%" fill="url(#g)"/><circle cx="${Math.round(width * .58)}" cy="${Math.round(height * .68)}" r="${Math.round(Math.min(width, height) * .24)}" fill="#d69b61"/><ellipse cx="${Math.round(width * .51)}" cy="${Math.round(height * .65)}" rx="${Math.round(width * .03)}" ry="${Math.round(height * .04)}" fill="#221914"/><ellipse cx="${Math.round(width * .65)}" cy="${Math.round(height * .65)}" rx="${Math.round(width * .03)}" ry="${Math.round(height * .04)}" fill="#221914"/></svg>`)).png().toBuffer();
    const plan = {
      title: profile.title,
      subtitle: profile.subtitle,
      aspectRatio: ratio,
      layoutTemplateId: profile.layoutTemplateId,
      animationStyleId: "pet-3d",
      coverModeId: profile.coverModeId,
      materialSourceId: profile.materialSourceId,
      subjectModeId: "semantic",
    };
    assert.equal(pure.coverCompositionValidationError(plan), null);
    const rendered = await renderer.renderCoverComposition(background, plan);
    assert.equal(rendered.compositionProfile, profile.expected);
    assert.ok(rendered.renderedText.lines.length >= 1 && rendered.renderedText.lines.length <= 3);
    assert.equal(rendered.width / rendered.height, Number(ratio.split(":")[0]) / Number(ratio.split(":")[1]));
    const output = `${directory}/${profile.key}-${ratio.replace(":", "x")}.png`;
    writeFileSync(output, rendered.bytes);
    const cell = await sharp(rendered.bytes).resize(276, 350, { fit: "contain", background: "#0b111a" }).extend({
      top: 42, bottom: 8, left: 12, right: 12, background: "#0b111a",
    }).composite([{ input: Buffer.from(`<svg width="300" height="42" xmlns="http://www.w3.org/2000/svg"><text x="14" y="27" fill="#e9f2ff" font-family="Arial" font-size="17" font-weight="700">${profile.key} · ${ratio}</text></svg>`), left: 0, top: 0 }]).png().toBuffer();
    cells.push(cell);
    results.push({
      profile: profile.expected,
      ratio,
      output,
      width: rendered.width,
      height: rendered.height,
      lines: rendered.renderedText.lines,
      sha256: createHash("sha256").update(rendered.bytes).digest("hex"),
    });
  }
}

for (const ratio of Object.keys(ratios)) {
  assert.equal(new Set(results.filter((item) => item.ratio === ratio).map((item) => item.sha256)).size, 3, `${ratio} profiles must render different pixels`);
}
const sheet = sharp({ create: { width: 1200, height: 1200, channels: 3, background: "#070b12" } });
await sheet.composite(cells.map((input, index) => ({ input, left: (index % 4) * 300, top: Math.floor(index / 4) * 400 }))).png().toFile(`${directory}/三路线四比例排版矩阵.png`);
const summary = {
  passed: true,
  publicReferenceImagesCopied: 0,
  paidRequests: 0,
  profiles: profiles.map((item) => item.expected),
  ratios: Object.keys(ratios),
  renderedFixtures: results.length,
  promptBlocksEmptyBars: true,
  modeSourcePersisted: true,
  themeAwareResultStage: true,
  results,
};
writeFileSync(`${directory}/summary.json`, JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary));
