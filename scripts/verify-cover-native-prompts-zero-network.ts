import assert from "node:assert/strict";
import { COVER_BENCHMARK_PROMPT_PACKS } from "../src/lib/cover-benchmark-prompt-packs";
import { resolveBenchmarkCoverLayout } from "../src/lib/cover-benchmark-layout";
import {
  coverOutputSpec, parseCoverContentAnalysis, parseCoverPrepareInput, resolveCoverStyle,
  CoverStyleDefinitionSchema, CoverPrepareInputSchema, CoverContentAnalysisSchema,
  type CoverContentAnalysis, type CoverPrepareInput, type CoverRatio,
} from "../src/lib/cover-workbench-contract";
import {
  compileCoverAnalysisMessages, compileCoverBackgroundPrompt, compileCoverNativePrompt,
  coverAnalysisDependencySnapshot, COVER_ANALYSIS_PROMPT_VERSION, COVER_PREVIOUS_ANALYSIS_PROMPT_VERSION,
  COVER_ADDITIONAL_ANALYSIS_PROMPT_VERSIONS, COVER_NATIVE_PROMPT_VERSION, type CoverNativePromptInput,
  coverNativeTitleLines,
} from "../src/lib/cover-workbench-prompts";

// Fixtures exercise compilation/grounding contracts, never claim an LLM saw an
// image, generated these titles, or produced a correct final Chinese cover.
const cases = [
  { id: "cat", text: "猫每次听到抽屉打开就跑过来，因为它的逗猫棒放在里面。它现在看着我手里的逗猫棒。",
    subject: "一只猫", action: "猫看着人手里的逗猫棒", scene: "抽屉旁", emotion: "期待",
    titles: ["猫听见抽屉\n就跑过来", "抽屉一开\n猫就来报到？"] },
  { id: "dog", text: "狗把球放到我脚边，然后抬头看我。我拿起球，它就跑到前面等着。",
    subject: "一只狗", action: "狗把球放在人脚边后抬头看人", scene: "日常室内", emotion: "期待",
    titles: ["狗把球放脚边\n然后抬头看你", "球放脚边\n狗在等什么？"] },
  { id: "human-pet", text: "我坐在沙发上看书，小狗把下巴放在我的膝盖上。我放下书摸它的头，它闭上眼睛。",
    subject: "一个人与一只小狗", action: "人放下书摸膝边小狗的头，小狗闭眼", scene: "沙发旁", emotion: "亲近",
    titles: ["放下书摸摸它\n小狗闭上了眼", "书还没看完\n小狗先靠过来了"] },
];
const styles = ["cartoon", "funny-cartoon"] as const;
const checks: string[] = [];
let networkCalls = 0;
const savedFetch = globalThis.fetch;
globalThis.fetch = async () => { networkCalls++; throw new Error("Unexpected network access"); };
function check(name: string, fn: () => void) { fn(); checks.push(name); }
function materials(styleKey: string, text: string, patch: Partial<CoverPrepareInput> = {}) {
  return parseCoverPrepareInput({ clientRequestId: "cover_native_fixture_0001", text, styleKey, ...patch });
}
function analysisFor(fixture: typeof cases[number], title: string, input: CoverPrepareInput): CoverContentAnalysis {
  return parseCoverContentAnalysis({
    schemaVersion: "cover-content-analysis/1", status: "ready", topic: fixture.text, primaryTitle: title, secondaryTitle: null,
    visualBrief: { subject: fixture.subject, action: fixture.action, scene: fixture.scene, emotion: fixture.emotion },
    titleCandidates: [{ id: "title", text: title, evidenceRefs: ["e1"] }],
    evidence: [{ id: "e1", source: "text", quote: fixture.text,
      fields: ["topic", "primaryTitle", "visualBrief.subject", "visualBrief.action", "visualBrief.scene", "visualBrief.emotion"] }],
    contentBreakdown: { summary: { text: fixture.text, evidenceRefs: ["e1"] }, keyPoints: [{ text: fixture.action, evidenceRefs: ["e1"] }],
      logic: { text: "原文给出连续的行为与回应，不补造额外结果", evidenceRefs: ["e1"] },
      coverFocus: { text: fixture.action, evidenceRefs: ["e1"] } },
    layoutIntent: { structure: fixture.id === "human-pet" ? "relationship" : "single", focus: "action", evidenceRefs: ["e1"] },
    missingInformation: [],
  }, input);
}
function compilerInput(styleKey: typeof styles[number] = "cartoon", ratio: CoverRatio = "3:4"): CoverNativePromptInput {
  const input = materials(styleKey, cases[0].text, { outputRatio: ratio });
  return { materials: input, style: resolveCoverStyle(styleKey), analysis: analysisFor(cases[0], cases[0].titles[0], input),
    generationSpec: { modelId: "pm_fixture_image", resolution: "2K", aspectRatio: ratio, outputRatio: ratio, ratioEvidence: "declared_native" },
    outputSpec: coverOutputSpec(ratio) };
}
function payload(prompt: string) { return JSON.parse(prompt.slice(prompt.lastIndexOf("\n") + 1)); }

try {
  for (const fixture of cases) {
    const prompts: string[] = [], facts: unknown[] = [];
    for (const [i, styleKey] of styles.entries()) {
      check(`${fixture.id}/${styleKey}: grounded content and exact native title in two ratios`, () => {
        const input = materials(styleKey, fixture.text);
        const analysis = analysisFor(fixture, fixture.titles[i], input);
        facts.push({ evidence: analysis.evidence, visualBrief: analysis.visualBrief, contentBreakdown: analysis.contentBreakdown });
        const messages = compileCoverAnalysisMessages(input);
        assert.ok(messages[0].content.includes(COVER_BENCHMARK_PROMPT_PACKS[styleKey].analysisRules[2]));
        const user = JSON.parse(messages[1].content);
        assert.equal(user.selectedStyle.key, styleKey);
        assert.equal(user.selectedStyle.promptPackVersion, COVER_BENCHMARK_PROMPT_PACKS[styleKey].version);
        assert.ok(user.sourceSpans.some((span: { text: string }) => fixture.text.includes(span.text)));
        for (const ratio of ["3:4", "16:9"] as const) {
          const layout = resolveBenchmarkCoverLayout({ analysis, styleKey, ratio });
          const prompt = compileCoverNativePrompt({ ...compilerInput(styleKey, ratio), materials: { ...input, outputRatio: ratio }, analysis, layoutPlan: layout });
          const data = payload(prompt);
          assert.deepEqual(data.requestedText, { title: fixture.titles[i], subtitle: null });
          assert.deepEqual(data.titleLines, fixture.titles[i].split("\n"));
          assert.equal(data.lineCount, 2); assert.equal(data.maxTitleLines, 2); assert.equal(data.allowAdditionalTitleWrap, false);
          assert.deepEqual(data.visualBrief, analysis.visualBrief);
          assert.equal(data.style.key, styleKey);
          assert.equal(data.textVerification, "unverified");
          assert.equal(data.outputSpec.aspectRatio, ratio);
          assert.equal(data.allowUpscale, false);
          assert.ok(!prompt.includes("The application renders all final Chinese text separately"));
          assert.ok(!prompt.includes("Do not draw title text"));
          assert.ok(!prompt.includes("不生成标题、数字、字母"));
          if (styleKey === "funny-cartoon") assert.ok(prompt.includes("单个字内部") && prompt.includes("深酒红/深紫厚侧面"));
          else assert.ok(prompt.includes("书写感字") && prompt.includes("眼神、手爪"));
          prompts.push(prompt);
        }
      });
    }
    check(`${fixture.id}: both styles keep the same factual fixture and distinct expression`, () => {
      assert.deepEqual(facts[0], facts[1]);
      assert.notEqual(prompts[0], prompts[2]);
      assert.notEqual(fixture.titles[0], fixture.titles[1]);
    });
  }
  check("manual requested text/newline and explicit subtitle removal remain exact", () => {
    const input = compilerInput(); input.analysis.secondaryTitle = "原副题";
    assert.deepEqual(payload(compileCoverNativePrompt({ ...input, requestedText: { title: "手工锁定\nA/B", subtitle: null } })).requestedText,
      { title: "手工锁定\nA/B", subtitle: null });
    assert.equal(payload(compileCoverNativePrompt({ ...input, requestedText: { title: "标题", subtitle: "  " } })).requestedText.subtitle, null);
  });
  check("native invalid, empty, oversized and three/four-line final text fail closed", () => {
    for (const title of ["", "x".repeat(81), "一\n二\n三", "一\n二\n三\n四", "a\u0000b"])
      assert.throws(() => compileCoverNativePrompt({ ...compilerInput(), requestedText: { title } }), /COVER_NATIVE_TEXT_INVALID/u);
  });
  check("confirmed title with no newline gets exact punctuation/balanced two-line layout without rewriting", () => {
    const title = "它不是要吃的，是要我回头？";
    const data = payload(compileCoverNativePrompt({ ...compilerInput("funny-cartoon"), requestedText: { title } }));
    assert.equal(data.requestedText.title, title);
    assert.deepEqual(data.titleLines, ["它不是要吃的，", "是要我回头？"]);
    assert.equal(data.titleLines.join(""), title); assert.equal(data.lineCount, 2);
    for (const value of ["ABCDEFGHIJKLMNOPQRSTUVWXYZ", "橘猫静静等着主人认真回应它的陪伴", "陪伴👨‍👩‍👧‍👦不是等待，是一起生活。", "保持一段完整英文 word and punctuation!"]) {
      const lines = coverNativeTitleLines(value); assert.equal(lines.length, 2); assert.equal(lines.join(""), value);
    }
    assert.deepEqual(coverNativeTitleLines("先做十分钟"), ["先做十分钟"]);
    assert.deepEqual(coverNativeTitleLines("保留第一行，\r\n保留第二行？"), ["保留第一行，", "保留第二行？"]);
  });
  check("native output mismatch and unready analysis fail before generation", () => {
    const input = compilerInput();
    assert.throws(() => compileCoverNativePrompt({ ...input, outputSpec: { ...input.outputSpec, width: 1 } }), /COVER_OUTPUT_SPEC_MISMATCH/u);
    assert.throws(() => compileCoverNativePrompt({ ...input, analysis: { ...input.analysis, status: "needs_input", missingInformation: ["请补充具体动作"] } }), /COVER_CONTENT_PLAN_NOT_READY/u);
  });
  check("native aspect mismatch preserves the complete image with explicit contain, never center-crop", () => {
    const input = compilerInput();
    const mismatched = { ...input, generationSpec: { ...input.generationSpec, aspectRatio: "9:16" as const } };
    assert.throws(() => compileCoverNativePrompt(mismatched), /COVER_NATIVE_CROP_UNSAFE/u);
    const prompt = compileCoverNativePrompt({ ...mismatched, outputSpec: { ...input.outputSpec, fit: "contain" } });
    assert.equal(payload(prompt).outputSpec.fit, "contain"); assert.ok(prompt.includes("完整保留原生图并留白"));
    assert.throws(() => compileCoverNativePrompt({ ...mismatched, outputSpec: { ...input.outputSpec, fit: "contain" }, generationSpec: {
      ...mismatched.generationSpec, ratioEvidence: "application_crop_mapping", crop: { strategy: "center_crop", allowUpscale: false, policyId: "fixture", evidence: "fixture" },
    } }), /COVER_NATIVE_CROP_UNSAFE/u);
  });
  check("product, reference, composition and original-layout never bind creator/native rules", () => {
    const assetId = "00000000-0000-4000-8000-000000000002";
    const patches: Partial<CoverPrepareInput>[] = [{ contentKind: "product" }, { assets: [{ assetId, role: "style_reference" }] },
      { assets: [{ assetId, role: "background_canvas" }] }, { imageMode: "compose", assets: [{ assetId, role: "identity_subject", imageNumber: 1 }] }];
    for (const patch of patches) {
      const input = compilerInput(), prepared = materials("cartoon", cases[0].text, patch);
      assert.equal(coverAnalysisDependencySnapshot(prepared).promptPack, null);
      assert.equal(JSON.parse(compileCoverAnalysisMessages(prepared)[1].content).selectedStyle, undefined);
      assert.throws(() => compileCoverNativePrompt({ ...input, materials: prepared }), /COVER_NATIVE_STYLE_UNSUPPORTED/u);
    }
  });
  check("dependencies differ by style and snapshot mutations cannot rewrite current packs", () => {
    const a = coverAnalysisDependencySnapshot(materials("cartoon", cases[0].text));
    const b = coverAnalysisDependencySnapshot(materials("funny-cartoon", cases[0].text));
    assert.notDeepEqual(a, b); assert.equal(a.styleVersion, "3.0.0"); assert.equal(a.promptPackVersion, "2.2.0");
    assert.ok(a.promptPack); a.promptPack.nativeCoverRules.push("fixture mutation");
    assert.ok(!coverAnalysisDependencySnapshot(materials("cartoon", cases[0].text)).promptPack?.nativeCoverRules.includes("fixture mutation"));
    assert.deepEqual(coverAnalysisDependencySnapshot(materials("cartoon", cases[0].text)), coverAnalysisDependencySnapshot(materials("cartoon", cases[0].text)));
  });
  check("frozen paid pack is authoritative and never silently replaced by current rules", () => {
    const input = compilerInput(), frozen = structuredClone(COVER_BENCHMARK_PROMPT_PACKS.cartoon);
    frozen.version = "0.9.0"; frozen.nativeCoverRules = ["FROZEN_NATIVE_CONTRACT_SENTINEL"];
    const legacyStyle = { ...input.style, version: "2.0.0", typography: { ...input.style.typography, maxLines: 3 as const } };
    assert.equal(CoverStyleDefinitionSchema.parse(legacyStyle).typography.maxLines, 3);
    const prompt = compileCoverNativePrompt({ ...input, style: legacyStyle, frozenPromptPack: frozen });
    assert.ok(prompt.includes("FROZEN_NATIVE_CONTRACT_SENTINEL")); assert.equal(payload(prompt).style.promptPackVersion, "0.9.0");
    assert.ok(!prompt.includes(COVER_BENCHMARK_PROMPT_PACKS.cartoon.nativeCoverRules[0]));
    assert.throws(() => compileCoverNativePrompt({ ...input, frozenPromptPack: null }), /COVER_NATIVE_STYLE_UNSUPPORTED/u);
    frozen.nativeCoverRules = [];
    assert.throws(() => compileCoverNativePrompt({ ...input, frozenPromptPack: frozen }), /COVER_NATIVE_PROMPT_SNAPSHOT_UNAVAILABLE/u);
  });
  check("legacy three-line stored analysis/materials remain readable while new manual preparation rejects three lines", () => {
    const input = compilerInput();
    assert.equal(input.style.typography.maxLines, 2);
    const title = "旧标题第一行\n旧标题第二行\n旧标题第三行";
    assert.equal(CoverContentAnalysisSchema.parse({ ...input.analysis, primaryTitle: title }).primaryTitle, title);
    const oldMaterials = { ...input.materials!, manualTitle: title };
    assert.equal(CoverPrepareInputSchema.parse(oldMaterials).manualTitle, title);
    assert.throws(() => parseCoverPrepareInput(oldMaterials), error => error instanceof Error && "code" in error
      && error.code === "COVER_TITLE_LINE_LIMIT" && error.message.includes("两行"));
  });
  check("legacy overlay compiler still requests a text-free background", () => {
    assert.ok(compileCoverBackgroundPrompt(compilerInput()).includes("Do not draw title text"));
  });
  check("image analysis requests complete stable role decisions and an explicit conflict question", () => {
    const input = materials("cartoon", "@图7是人物主体，@图3是参考封面。", { imageMode: "compose", assets: [
      { assetId: "00000000-0000-4000-8000-000000000003", imageNumber: 7, role: "background_canvas" },
      { assetId: "00000000-0000-4000-8000-000000000004", imageNumber: 3, role: "identity_subject" },
    ] });
    const messages = compileCoverAnalysisMessages(input), user = JSON.parse(messages[1].content);
    assert.deepEqual(user.materialUsageBindings.map((row: { imageNumber: number }) => row.imageNumber), [7, 3]);
    assert.equal(user.materialUsageBindings[0].role, "background_canvas");
    assert.ok(messages[0].content.includes("每张实际输入图片恰好一项"));
    assert.ok(messages[0].content.includes("source='explicit_user'"));
    assert.ok(messages[0].content.includes("不采用最后一句覆盖"));
    assert.equal(user.selectedStyle, undefined);
  });
  check("single-instant directions preserve completed prop states and per-person hand tasks without topic keywords", () => {
    const instants = [
      { id: "after-place", text: "我把茶杯放稳在左侧边桌上。此刻左手扶住围巾，右手拉平围巾，茶杯留在桌上。",
        subject: "一个人", action: "茶杯已放稳在左侧边桌上；此刻左手扶住围巾，右手拉平围巾，双手都没有持握茶杯。",
        scene: "边桌旁", emotion: "专注", titles: ["茶杯已放稳\n再整理围巾", "杯子放好了\n围巾也理好了"] },
      { id: "after-handover", text: "母亲把钥匙交给父亲。交接完成后，钥匙由父亲右手握住，父亲左手自然放松；母亲左手扶着包，右手自然垂下。",
        subject: "母亲与父亲", action: "交接已经完成，钥匙只在父亲右手中，父亲左手放松；母亲左手扶包、右手垂下，母亲不再持握钥匙。",
        scene: "日常门边", emotion: "平静", titles: ["交接已经完成\n钥匙在父亲手里", "钥匙交出后\n谁还握着它？"] },
      { id: "after-put-away", text: "工作人员将剪刀放回桌面工具盒。此刻剪刀平放盒中，左右手共同端起托盘，工具盒留在台面。",
        subject: "一个工作人员", action: "剪刀已平放桌面工具盒中；此刻左右手共同端稳托盘，两手都不持剪刀，工具盒留在台面。",
        scene: "工作台旁", emotion: "专注", titles: ["剪刀已收好\n两手端稳托盘", "剪刀归盒\n托盘该怎么端？"] },
    ];
    for (const fixture of instants) for (const [index, styleKey] of styles.entries()) {
      const input = materials(styleKey, fixture.text), analysis = analysisFor(fixture, fixture.titles[index], input);
      const messages = compileCoverAnalysisMessages(input), system = messages[0].content;
      assert.ok(system.includes("coverFocus只选一个可画的目标时刻"));
      assert.ok(system.includes("visualBrief.action只写这个时刻"));
      const prompt = compileCoverNativePrompt({ ...compilerInput(styleKey), materials: input, analysis });
      assert.equal(payload(prompt).visualBrief.action, fixture.action);
      const rule = COVER_BENCHMARK_PROMPT_PACKS[styleKey].nativeCoverRules.find(item => item.includes("每个人物只有其正常左右两手"))!;
      assert.ok(prompt.includes(rule)); assert.ok(rule.includes("每个人物只有其正常左右两手"));
      assert.ok(rule.includes("前序已放置、交出、收起或关闭"));
      assert.ok(!rule.includes("猫") && !rule.includes("手机"));
      assert.ok(rule.includes("不能声称提示词保证解剖正确"));
    }
  });
  check("new instant rules invalidate fresh dependency versions while retaining paid-history readers", () => {
    const deps = coverAnalysisDependencySnapshot(materials("cartoon", cases[0].text));
    assert.equal(COVER_ANALYSIS_PROMPT_VERSION, "cover-content-analysis/2.8.0");
    assert.equal(COVER_NATIVE_PROMPT_VERSION, "cover-native/1.3.0");
    assert.equal(deps.promptPackVersion, "2.2.0");
    assert.equal(COVER_PREVIOUS_ANALYSIS_PROMPT_VERSION, "cover-content-analysis/2.7.0");
    assert.ok(COVER_ADDITIONAL_ANALYSIS_PROMPT_VERSIONS.includes("cover-content-analysis/2.6.0"));
    assert.ok(COVER_ADDITIONAL_ANALYSIS_PROMPT_VERSIONS.includes("cover-content-analysis/2.4.0"));
    const previous = { ...deps, analysisPromptVersion: "cover-content-analysis/2.5.0", nativePromptVersion: "cover-native/1.0.0", promptPackVersion: "2.0.0" };
    assert.notEqual(JSON.stringify(deps), JSON.stringify(previous));
  });
  assert.equal(networkCalls, 0);
  console.log(JSON.stringify({ status: "passed", checks: checks.length, cases: checks, networkCalls,
    evidence: "zero-network prompt/fixture contracts only; no model analysis, generated images, visual QA, billing, history or download acceptance" }, null, 2));
} finally { globalThis.fetch = savedFetch; }
