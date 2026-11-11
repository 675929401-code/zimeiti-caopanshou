export const COVER_OUTPUT_SPECS = {
  "16:9": { width: 1920, height: 1080 },
  "9:16": { width: 1080, height: 1920 },
  "4:3": { width: 1440, height: 1080 },
  "3:4": { width: 1080, height: 1440 },
} as const;
export type CoverOutputSpec = {
  aspectRatio: keyof typeof COVER_OUTPUT_SPECS;
  width: number;
  height: number;
  format: "png";
  fit?: "cover" | "contain";
};
export type CoverTitleStyle = {
  x?: number;
  y?: number;
  width?: number;
  scale?: number;
  color?: string;
  /** Absent keeps legacy semantics: color means single; no color means palette. */
  colorMode?: "palette" | "single";
};
export const COVER_ORIGINAL_LAYOUT_VERSION = "cover-original-layout/1" as const;
export type CoverOriginalLayout = {
  version: typeof COVER_ORIGINAL_LAYOUT_VERSION;
  sourceWidth: number;
  sourceHeight: number;
  structure: "single" | "relationship" | "comparison" | "list";
  focus: "expression" | "action" | "object";
};
export type CoverLayoutRect = { left: number; top: number; width: number; height: number };
export const COVER_GENERATED_OVERLAY_LAYOUT_VERSION = "cover-generated-overlay-safe-frame/1" as const;
/** A frozen algorithm, not a guessed region in an image which does not exist yet. */
export type CoverGeneratedOverlayLayout = {
  version: typeof COVER_GENERATED_OVERLAY_LAYOUT_VERSION;
  placement: "top";
  canvasColor: "#F5F5F2";
};
export function coverGeneratedOverlayPolicy(): CoverGeneratedOverlayLayout {
  return { version: COVER_GENERATED_OVERLAY_LAYOUT_VERSION, placement: "top", canvasColor: "#F5F5F2" };
}
export function coverGeneratedOverlayTitleStyle(): Required<CoverTitleStyle> {
  return { x: .04, y: .025, width: .92, scale: 1, color: "#152332", colorMode: "single" };
}
export function coverGeneratedOverlayLayoutMatches(left: unknown, right: unknown): boolean {
  if (left === undefined || right === undefined) return left === right;
  if (!left || !right || typeof left !== "object" || typeof right !== "object") return false;
  const valid = (value: object) => onlyKeys(value, ["version", "placement", "canvasColor"])
    && (value as CoverGeneratedOverlayLayout).version === COVER_GENERATED_OVERLAY_LAYOUT_VERSION
    && (value as CoverGeneratedOverlayLayout).placement === "top" && (value as CoverGeneratedOverlayLayout).canvasColor === "#F5F5F2";
  return valid(left) && valid(right);
}
/** Complete photo below an independent title band. Actual source metadata is
 * an input to this pure algorithm; it is never written back into the plan. */
export function coverGeneratedOverlayGeometry(plan: Pick<CoverCompositionPlan, "outputSpec" | "title" | "subtitle">, sourceWidth: number, sourceHeight: number) {
  const output = plan.outputSpec!, { width, height } = output;
  const pad = Math.max(20, Math.round(Math.min(width, height) * .025));
  const band = Math.round(height * Math.min(.36, .24 + Array.from(plan.title + plan.subtitle).length * .0007));
  const style = coverGeneratedOverlayTitleStyle();
  const titleTop = Math.round(height * style.y);
  const title = { left: Math.round(width * style.x), top: titleTop, width: Math.round(width * style.width), height: band - titleTop * 2 };
  const area = { left: pad, top: band + pad, width: width - pad * 2, height: height - band - pad * 2 };
  const scale = Math.min(area.width / sourceWidth, area.height / sourceHeight, 1);
  const w = Math.max(1, Math.round(sourceWidth * scale)), h = Math.max(1, Math.round(sourceHeight * scale));
  return { title, image: { left: area.left + Math.floor((area.width - w) / 2), top: area.top + Math.floor((area.height - h) / 2), width: w, height: h }, placement: "top" as const };
}
export type CoverOriginalLayoutGeometry = { image: CoverLayoutRect; title: CoverLayoutRect; placement: "left" | "right" | "top" | "bottom"; usesExistingPadding: boolean };

/** Text always occupies a dedicated area OUTSIDE the complete photograph.
 * Semantic observations are not a segmentation/face safety guarantee. */
export function coverOriginalLayoutGeometry(plan: Pick<CoverCompositionPlan, "originalLayout" | "outputSpec" | "title" | "subtitle">): CoverOriginalLayoutGeometry {
  const source = plan.originalLayout!, output = plan.outputSpec!;
  const width = output.width, height = output.height;
  const pad = Math.max(20, Math.round(Math.min(width, height) * .025));
  const fit = (area: CoverLayoutRect): CoverLayoutRect => {
    const scale = Math.min(area.width / source.sourceWidth, area.height / source.sourceHeight, 1);
    const w = Math.max(1, Math.round(source.sourceWidth * scale)), h = Math.max(1, Math.round(source.sourceHeight * scale));
    return { left: area.left + Math.floor((area.width - w) / 2), top: area.top + Math.floor((area.height - h) / 2), width: w, height: h };
  };
  const image = fit({ left: 0, top: 0, width, height });
  const side = source.focus === "expression" ? "right" : "left";
  const vertical = source.focus === "expression" ? "bottom" : "top";
  const candidates: Array<{ placement: CoverOriginalLayoutGeometry["placement"]; title: CoverLayoutRect }> = [
    { placement: side, title: { left: side === "left" ? pad : image.left + image.width + pad, top: pad, width: (side === "left" ? image.left : width - image.left - image.width) - pad * 2, height: height - pad * 2 } },
    { placement: vertical, title: { left: pad, top: vertical === "top" ? pad : image.top + image.height + pad, width: width - pad * 2, height: (vertical === "top" ? image.top : height - image.top - image.height) - pad * 2 } },
  ];
  // Lists/comparisons benefit from a wide reading band; other intents first
  // reuse the natural contain padding, without shrinking the photograph.
  if (source.structure !== "list" && source.structure !== "comparison") {
    const explicit = plan.title.split(/\r?\n/u).map(line => Array.from(line.trim()).length);
    const longestMainLine = explicit.length > 1 ? Math.max(...explicit) : Math.ceil(explicit[0] / 2);
    // Reserve at least a readable two-line title; a narrow sidebar must never
    // turn a long main title into a third/fourth visual line or tiny lettering.
    const candidate = candidates.find(item => item.title.width >= Math.max(200, longestMainLine * 40) && item.title.height >= 180);
    if (candidate) return { image, ...candidate, usesExistingPadding: true };
  }
  const length = Array.from(plan.title + plan.subtitle).length;
  const band = Math.round(height * Math.min(.43, .24 + length * .001));
  const placement = vertical;
  const photoArea = { left: 0, top: placement === "top" ? band + pad : 0, width, height: height - band - pad };
  return { image: fit(photoArea), title: { left: pad, top: placement === "top" ? pad : height - band + pad, width: width - pad * 2, height: band - pad * 2 }, placement, usesExistingPadding: false };
}

/** Map normalized source observations into OUTPUT pixels, including padding. */
export function mapCoverSourceRegionToOutput(region: { x: number; y: number; width: number; height: number }, image: CoverLayoutRect): CoverLayoutRect {
  return { left: image.left + region.x * image.width, top: image.top + region.y * image.height, width: region.width * image.width, height: region.height * image.height };
}

export function coverOriginalLayoutMatches(left: unknown, right: unknown): boolean {
  if (left === undefined || right === undefined) return left === right;
  if (!left || !right || typeof left !== "object" || typeof right !== "object") return false;
  return ["version", "sourceWidth", "sourceHeight", "structure", "focus"].every(key => (left as Record<string, unknown>)[key] === (right as Record<string, unknown>)[key]);
}
export const COVER_TEXT_RENDERING_VERSION = "cover-text-rendering/1" as const;
export type CoverTextRendering = { mode: "native" | "overlay"; version: typeof COVER_TEXT_RENDERING_VERSION };
export type CoverCompositionPlan = {
  title: string;
  subtitle: string;
  aspectRatio: "16:9" | "9:16" | "4:3" | "3:4";
  layoutTemplateId: string;
  animationStyleId: string;
  /** Optional for legacy history; every new Cover Studio task writes both fields. */
  coverModeId?: string;
  materialSourceId?: "text" | "template" | "upload";
  subjectModeId?: "semantic" | "product";
  planVersion?: 2;
  outputSpec?: CoverOutputSpec;
  titleStyle?: CoverTitleStyle;
  /** Missing on historical plans means application-rendered overlay text. */
  textRendering?: CoverTextRendering;
  /** Only new preserved-image confirmations opt into safe dedicated text areas. */
  originalLayout?: CoverOriginalLayout;
  /** Opt-in for new generated material artwork, or an explicit free editor action. */
  generatedOverlayLayout?: CoverGeneratedOverlayLayout;
};

export function coverTextRendering(plan: Pick<CoverCompositionPlan, "textRendering">): CoverTextRendering {
  return plan.textRendering ?? { mode: "overlay", version: COVER_TEXT_RENDERING_VERSION };
}

/** A request binding never proves that a model actually drew the requested glyphs. */
export function coverCompositionTextReceipt(plan: CoverCompositionPlan) {
  return coverTextRendering(plan).mode === "native"
    ? { textRendering: coverTextRendering(plan), requestedText: { title: plan.title, subtitle: plan.subtitle }, textVerification: "unverified" as const }
    : { ...(plan.textRendering ? { textRendering: plan.textRendering } : {}),
      ...(plan.generatedOverlayLayout ? { generatedOverlayLayout: plan.generatedOverlayLayout } : {}), renderedText: { title: plan.title, subtitle: plan.subtitle } };
}

/** Native source metadata is installed only by the owner-bound original export.
 * Plain user uploads have no such marker and retain their original overlay flow. */
export function coverSourcePlanBindingError(meta: unknown, plan: CoverCompositionPlan): string | null {
  const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const binding = object(object(meta).coverGeneratedExport);
  if (!Object.prototype.hasOwnProperty.call(binding, "nativePlan")) return null;
  const original = binding.nativePlan as CoverCompositionPlan;
  const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical)
    : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)])) : value;
  if (!original || coverCompositionValidationError(original) || coverTextRendering(original).mode !== "native"
    || JSON.stringify(canonical(original)) !== JSON.stringify(canonical(plan))) return "原生封面的文字和画面已一起生成，请保留原作品并新建制作任务";
  return null;
}

function onlyKeys(value: object, keys: string[]) {
  return Object.keys(value).every(key => keys.includes(key));
}

export function coverV2ValidationError(plan: Pick<CoverCompositionPlan, "aspectRatio" | "planVersion" | "outputSpec" | "titleStyle" | "textRendering" | "originalLayout" | "generatedOverlayLayout" | "materialSourceId">): string | null {
  if (plan.planVersion === undefined) return plan.outputSpec !== undefined || plan.titleStyle !== undefined || plan.textRendering !== undefined || plan.originalLayout !== undefined || plan.generatedOverlayLayout !== undefined ? "新版导出与标题样式需要planVersion为2" : null;
  if (plan.planVersion !== 2) return "封面计划版本无效";
  if (plan.textRendering !== undefined && (!plan.textRendering || typeof plan.textRendering !== "object" || Array.isArray(plan.textRendering)
    || !onlyKeys(plan.textRendering, ["mode", "version"]) || !["native", "overlay"].includes(plan.textRendering.mode)
    || plan.textRendering.version !== COVER_TEXT_RENDERING_VERSION)) return "封面文字模式版本无效";
  const output = plan.outputSpec;
  const expected = COVER_OUTPUT_SPECS[plan.aspectRatio];
  if (!output || typeof output !== "object" || Array.isArray(output) || !onlyKeys(output, ["aspectRatio", "width", "height", "format", "fit"])
    || !expected || output.aspectRatio !== plan.aspectRatio || output.width !== expected.width || output.height !== expected.height
    || output.format !== "png" || (output.fit !== undefined && output.fit !== "cover" && output.fit !== "contain")) return "请选择有效的固定封面尺寸";
  if (coverTextRendering(plan).mode === "native" && output.fit !== "contain") return "原生封面需要完整保留画面，不能裁切已生成的文字";
  const original = plan.originalLayout;
  if (original !== undefined && (!original || typeof original !== "object" || Array.isArray(original)
    || !onlyKeys(original, ["version", "sourceWidth", "sourceHeight", "structure", "focus"])
    || original.version !== COVER_ORIGINAL_LAYOUT_VERSION || output.fit !== "contain" || coverTextRendering(plan).mode !== "overlay"
    || ![original.sourceWidth, original.sourceHeight].every(value => Number.isSafeInteger(value) && value >= 256)
    || original.sourceWidth * original.sourceHeight > 40_000_000
    || !["single", "relationship", "comparison", "list"].includes(original.structure) || !["expression", "action", "object"].includes(original.focus))) return "原图安全排版计划无效";
  const style = plan.titleStyle;
  if (plan.generatedOverlayLayout !== undefined && (!coverGeneratedOverlayLayoutMatches(plan.generatedOverlayLayout, coverGeneratedOverlayPolicy())
    || original !== undefined || coverTextRendering(plan).mode !== "overlay" || output.fit !== "contain"
    || !["upload", "template"].includes(plan.materialSourceId || "")
    || !style || !onlyKeys(style, Object.keys(coverGeneratedOverlayTitleStyle()))
    || !Object.entries(coverGeneratedOverlayTitleStyle()).every(([key, value]) => style[key as keyof CoverTitleStyle] === value))) return "自动留白排版策略无效，请重新应用自动留白排版";
  if (style === undefined) return null;
  if (!style || typeof style !== "object" || Array.isArray(style) || !onlyKeys(style, ["x", "y", "width", "scale", "color", "colorMode"])) return "标题样式无效";
  if (style.colorMode !== undefined && style.colorMode !== "palette" && style.colorMode !== "single") return "标题颜色模式无效";
  if (style.colorMode === "single" && style.color === undefined) return "单色标题需要明确颜色";
  const x = style.x ?? 0.07;
  const width = style.width ?? Math.min(0.86, 0.98 - x);
  if (![x, width, style.y ?? 0.055, style.scale ?? 1].every(value => typeof value === "number" && Number.isFinite(value))
    || x < 0.02 || x > 0.7 || width < 0.2 || x + width > 0.98 + 1e-12
    || (style.y !== undefined && (style.y < 0.02 || style.y > 0.5))
    || (style.scale !== undefined && (style.scale < 0.7 || style.scale > 1.3))
    || (style.color !== undefined && (typeof style.color !== "string" || !/^#[0-9a-f]{6}$/iu.test(style.color)))) return "标题位置、大小或颜色超出可用范围";
  return null;
}

/** Match the rendering endpoint before a paid background request is submitted. */
export function coverCompositionValidationError(plan: CoverCompositionPlan): string | null {
  if (!plan || typeof plan !== "object") return "封面排版计划无效";
  if (typeof plan.title !== "string" || !plan.title.trim() || plan.title.length > 80) return "封面标题请填写 1～80 个字符";
  if (typeof plan.subtitle !== "string" || plan.subtitle.length > 120) return "封面副标题不能超过 120 个字符";
  if (/[\x00-\x08\x0b-\x1f]/u.test(plan.title + plan.subtitle)) return "封面文字包含不支持的控制字符";
  if (plan.title.split(/\r?\n/u).length > 3) return "封面标题最多使用三行";
  if (plan.originalLayout && plan.title.split(/\r?\n/u).length > 2) return "原图安全排版标题最多使用两行";
  if (plan.generatedOverlayLayout && plan.title.split(/\r?\n/u).length > 2) return "自动留白排版标题最多使用两行";
  if (plan.coverModeId !== undefined && !/^[a-z0-9][a-z0-9-]{0,63}$/u.test(plan.coverModeId)) return "请选择有效的创作模式";
  if (plan.materialSourceId !== undefined && !["text", "template", "upload"].includes(plan.materialSourceId)) return "请选择有效的创作来源";
  if (plan.subjectModeId !== undefined && !["semantic", "product"].includes(plan.subjectModeId)) return "请选择有效的参考用途";
  if (!["16:9", "9:16", "4:3", "3:4"].includes(plan.aspectRatio)
    || !/^gaoding-[a-z0-9-]{1,48}$/u.test(plan.layoutTemplateId)
    || !["pet-3d", "pixar-3d", "clay-soft", "storybook", "anime-soft", "cinematic-real", "photo-real"].includes(plan.animationStyleId)) return "请选择有效的封面比例、版式与风格";
  return coverV2ValidationError(plan);
}

/** The model supplies artwork only; the application owns every visible glyph. */
export function buildCoverBackgroundPrompt(input: {
  brief: string;
  visualStyle: string;
  layoutHint: string;
  coverModeId?: string;
  materialSourceId?: "text" | "template" | "upload";
}): string {
  const modeRule = input.materialSourceId === "template"
    ? "学习参考模板的主体占比、阅读动线和自然负空间；原图中的文字框、条幅或底栏只学习占比，底图必须改成连续场景或自然纹理，不能复刻为空框。"
    : input.materialSourceId === "upload"
      ? "学习参考图的主体关系、构图节奏和色彩氛围，所有需要叠字的区域必须仍是连续场景或自然纹理。"
      : input.coverModeId === "funny-cartoon"
        ? "突出夸张而清晰的表情反应，主体占据中下部，上方保留连续场景中的低细节区域。"
        : "突出温暖的情绪关系和故事瞬间，主体位于中下部，在场景中自然形成可阅读的低细节区域。";
  return [
    "生成一张无字封面底图，只生成主体、环境、材质与光影。",
    `内容场景：${input.brief}`,
    `画面风格：${input.visualStyle}`,
    `版式参考：${input.layoutHint}；只参考主体关系、阅读动线与自然负空间，不绘制任何文字。`,
    modeRule,
    "主体完整且面部不被遮挡。供后续排版的位置必须是画面本身的连续背景，不能生成空白文字框、黑色横条、白色底栏、卡片、色块占位或标题框。",
    "硬性要求：画面内不得出现汉字、英文字母、数字、标点符号、标题、副标题、标语、标识、水印、拟文字或任何可被误认为文字的笔画。文字将由应用程序逐字绘制，请勿代写或改写文案。",
  ].join("\n");
}

export function coverTitleColorMode(style?: CoverTitleStyle): "palette" | "single" {
  return style?.colorMode ?? (style?.color === undefined ? "palette" : "single");
}

/** Compare what the renderer consumes. Palette mode intentionally ignores an
 * old color-picker value; an explicit single color matches the legacy shape. */
export function coverTitleStyleMatches(actual?: CoverTitleStyle, expected?: CoverTitleStyle): boolean {
  if (!( ["x", "y", "width", "scale"] as const).every(key => actual?.[key] === expected?.[key])) return false;
  const mode = coverTitleColorMode(actual);
  return mode === coverTitleColorMode(expected)
    && (mode === "palette" || actual?.color?.toLowerCase() === expected?.color?.toLowerCase());
}

export function coverCompositionMatches(value: unknown, plan: CoverCompositionPlan, sourceAssetId: string): boolean {
  if (!value || typeof value !== "object") return false;
  const row = value as Record<string, unknown>;
  const native = coverTextRendering(plan).mode === "native";
  const text = (native ? row.requestedText : row.renderedText) as Record<string, unknown> | undefined;
  const textRendering = row.textRendering as CoverTextRendering | undefined;
  const output = row.outputSpec as CoverOutputSpec | undefined;
  const style = row.titleStyle as CoverTitleStyle | undefined;
  return row.outputKind === "cover-composition" && row.sourceAssetId === sourceAssetId
    && text?.title === plan.title && text?.subtitle === plan.subtitle
    && (textRendering?.mode ?? "overlay") === coverTextRendering(plan).mode
    && (!textRendering || textRendering.version === COVER_TEXT_RENDERING_VERSION)
    && (!native || row.textVerification === "unverified" && row.renderedText === undefined && textRendering?.version === COVER_TEXT_RENDERING_VERSION)
    && (plan.planVersion !== 2 || (row.planVersion === 2 && row.width === plan.outputSpec?.width && row.height === plan.outputSpec?.height
      && output?.aspectRatio === plan.outputSpec?.aspectRatio && output?.width === plan.outputSpec?.width && output?.height === plan.outputSpec?.height
      && output?.format === "png" && (output?.fit ?? "cover") === (plan.outputSpec?.fit ?? "cover")
      && coverTitleStyleMatches(style, plan.titleStyle) && coverOriginalLayoutMatches(row.originalLayout, plan.originalLayout)
      && coverGeneratedOverlayLayoutMatches(row.generatedOverlayLayout, plan.generatedOverlayLayout)));
}
