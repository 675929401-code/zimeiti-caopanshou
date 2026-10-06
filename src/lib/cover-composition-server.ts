import { existsSync } from "node:fs";
import sharp from "sharp";
import type { CoverCompositionPlan } from "./cover-composition";

export const COVER_COMPOSITION_VERSION = "cover-composition-v2";

// This project ships a minimal ambient Sharp declaration. Keep the additional
// API used by cover rendering precise and local to this module.
interface CoverSharpPipeline {
  metadata(): Promise<{ width?: number; height?: number; orientation?: number }>;
  rotate(): CoverSharpPipeline;
  resize(width: number, height: number, options: { fit: "cover"; withoutEnlargement: boolean }): CoverSharpPipeline;
  png(options?: { compressionLevel?: number }): CoverSharpPipeline;
  composite(layers: Array<{ input: Buffer; left?: number; top?: number }>): CoverSharpPipeline;
  toBuffer(): Promise<Buffer>;
  toBuffer(options: { resolveWithObject: true }): Promise<{ data: Buffer; info: { width: number; height: number } }>;
}
type CoverSharpInput = Buffer | { text: { text: string; font: string; fontfile: string; width: number; height: number; align: "left" | "center"; rgba: true } };
const coverSharp = sharp as unknown as (input: CoverSharpInput, options?: { failOn: "error"; limitInputPixels: number }) => CoverSharpPipeline;
type RenderCoverCompositionPlan = Omit<CoverCompositionPlan, "aspectRatio"> & {
  aspectRatio: CoverCompositionPlan["aspectRatio"] | "1:1";
};

export type CoverCompositionProfile = "story-cartoon" | "funny-cartoon" | "reference-adaptive";

export function coverCompositionFont(profile: CoverCompositionProfile = "reference-adaptive") {
  const profileCandidates: Record<CoverCompositionProfile, Array<{ path: string; family: string }>> = {
    "story-cartoon": [
      { path: "C:/Windows/Fonts/方正粗黑宋简体.ttf", family: "方正粗黑宋简体" },
      { path: "C:/Windows/Fonts/msyhbd.ttc", family: "Microsoft YaHei Bold" },
    ],
    "funny-cartoon": [
      { path: "C:/Windows/Fonts/HYZhongHeiTi-197.ttf", family: "汉仪中黑 197" },
      { path: "C:/Windows/Fonts/simhei.ttf", family: "SimHei" },
      { path: "C:/Windows/Fonts/msyhbd.ttc", family: "Microsoft YaHei Bold" },
    ],
    "reference-adaptive": [
      { path: "C:/Windows/Fonts/msyhbd.ttc", family: "Microsoft YaHei Bold" },
      { path: "C:/Windows/Fonts/方正粗黑宋简体.ttf", family: "方正粗黑宋简体" },
    ],
  };
  const candidates = [
    ...profileCandidates[profile],
    { path: "/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc", family: "Noto Sans CJK SC Bold" },
    { path: "/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc", family: "WenQuanYi Zen Hei" },
  ];
  return candidates.find((font) => existsSync(font.path)) || null;
}

const escapeMarkup = (value: string) => value.replace(/[&<>"']/gu, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" }[char]!));

const profileForPlan = (plan: RenderCoverCompositionPlan): CoverCompositionProfile => plan.materialSourceId === "template" || plan.materialSourceId === "upload"
  ? "reference-adaptive"
  : plan.coverModeId === "funny-cartoon" ? "funny-cartoon" : "story-cartoon";

function splitBalanced(value: string, count: number) {
  const characters = Array.from(value.trim());
  const lines: string[] = [];
  let cursor = 0;
  for (let index = 0; index < count; index += 1) {
    const remainingLines = count - index;
    if (remainingLines === 1) {
      lines.push(characters.slice(cursor).join("").trim());
      break;
    }
    const target = cursor + Math.ceil((characters.length - cursor) / remainingLines);
    let breakpoint = target;
    for (let offset = 0; offset <= 3; offset += 1) {
      const forward = target + offset;
      const backward = target - offset;
      if (forward < characters.length && /[，。？！、；：,.!?]/u.test(characters[forward])) { breakpoint = forward + 1; break; }
      if (backward > cursor && /[，。？！、；：,.!?]/u.test(characters[backward - 1])) { breakpoint = backward; break; }
    }
    lines.push(characters.slice(cursor, breakpoint).join("").trim());
    cursor = breakpoint;
  }
  return lines.filter(Boolean);
}

export function coverTitleLines(title: string, aspectRatio: RenderCoverCompositionPlan["aspectRatio"]) {
  const explicit = title.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
  if (explicit.length > 1) return explicit.slice(0, 3);
  const value = explicit[0] || title.trim();
  const portrait = aspectRatio === "9:16" || aspectRatio === "3:4";
  const oneLineLimit = portrait ? 8 : 13;
  const twoLineLimit = portrait ? 18 : 28;
  return splitBalanced(value, value.length <= oneLineLimit ? 1 : value.length <= twoLineLimit ? 2 : 3);
}

export async function renderCoverComposition(source: Buffer, plan: RenderCoverCompositionPlan) {
  const profile = profileForPlan(plan);
  const font = coverCompositionFont(profile);
  if (!font) throw new Error("COVER_COMPOSITION_FONT_NOT_READY");
  const metadata = await coverSharp(source, { failOn: "error", limitInputPixels: 40_000_000 }).metadata();
  const swapAxes = [5, 6, 7, 8].includes(metadata.orientation || 1);
  const sourceWidth = (swapAxes ? metadata.height : metadata.width) || 0, sourceHeight = (swapAxes ? metadata.width : metadata.height) || 0;
  if (sourceWidth < 256 || sourceHeight < 256) throw new Error("COVER_BACKGROUND_TOO_SMALL");
  const [ratioWidth, ratioHeight] = plan.aspectRatio.split(":").map(Number);
  const unit = Math.floor(Math.min(sourceWidth / ratioWidth, sourceHeight / ratioHeight, 2560 / ratioWidth, 2560 / ratioHeight));
  const width = ratioWidth * unit, height = ratioHeight * unit;
  // Crop/downsize only: a small provider image never becomes a claimed native 2K image.
  const background = await coverSharp(source).rotate().resize(width, height, { fit: "cover", withoutEnlargement: true }).png().toBuffer();
  const portrait = height > width;
  const lines = coverTitleLines(plan.title, plan.aspectRatio);
  const layoutLeft = plan.layoutTemplateId === "gaoding-teacher-interview" || /(?:01|03|05|07|09)$/u.test(plan.layoutTemplateId);
  const align: "left" | "center" = profile === "funny-cartoon" ? "center" : layoutLeft ? "left" : "center";
  const padding = Math.max(22, Math.round(width * (portrait ? 0.06 : 0.045)));
  const titleLeft = profile === "reference-adaptive" && !portrait && layoutLeft ? padding : Math.round(width * (portrait ? 0.07 : 0.055));
  const titleWidth = profile === "reference-adaptive" && !portrait && layoutLeft
    ? Math.round(width * 0.56)
    : width - titleLeft * 2;
  const titleTop = Math.round(height * (profile === "funny-cartoon" ? 0.045 : 0.055));
  const titleZoneHeight = Math.round(height * (portrait ? (profile === "funny-cartoon" ? 0.31 : 0.27) : 0.3));
  const lineGap = Math.max(2, Math.round(height * 0.004));
  const lineHeight = Math.max(34, Math.floor((titleZoneHeight - lineGap * (lines.length - 1)) / Math.max(1, lines.length)));
  const outline = Math.max(2, Math.round(Math.min(width, height) * (profile === "funny-cartoon" ? 0.006 : 0.0045)));
  const palettes: Record<CoverCompositionProfile, string[]> = {
    "story-cartoon": ["#fff1b8", "#ffd05f", "#fffaf0"],
    "funny-cartoon": ["#ffcf4a", "#ff779f", "#66e4ff"],
    "reference-adaptive": ["#ffffff", "#ffe2a1", "#dff8ff"],
  };
  const stroke = profile === "story-cartoon" ? "#4a271d" : profile === "funny-cartoon" ? "#4a1437" : "#152332";
  const shadow = profile === "story-cartoon" ? "#b66028" : profile === "funny-cartoon" ? "#7c2c70" : "#09131e";
  const decorative = profile === "story-cartoon"
    ? Buffer.from(`<svg width="${width}" height="${height}"><defs><radialGradient id="warm"><stop stop-color="#5a281c" stop-opacity=".34"/><stop offset="1" stop-color="#5a281c" stop-opacity="0"/></radialGradient></defs><ellipse cx="${Math.round(width * .36)}" cy="${Math.round(height * .08)}" rx="${Math.round(width * .54)}" ry="${Math.round(height * .32)}" fill="url(#warm)"/><path d="M${padding} ${Math.round(height * .043)} h${Math.round(width * .09)}" stroke="#ffd166" stroke-width="${Math.max(5, Math.round(height * .006))}" stroke-linecap="round"/></svg>`)
    : profile === "funny-cartoon"
      ? Buffer.from(`<svg width="${width}" height="${height}"><defs><radialGradient id="pop"><stop stop-color="#32102b" stop-opacity=".38"/><stop offset="1" stop-color="#32102b" stop-opacity="0"/></radialGradient></defs><ellipse cx="${Math.round(width * .5)}" cy="${Math.round(height * .09)}" rx="${Math.round(width * .58)}" ry="${Math.round(height * .31)}" fill="url(#pop)"/><g fill="#67e8f9" opacity=".82"><circle cx="${Math.round(width * .08)}" cy="${Math.round(height * .08)}" r="${Math.max(4, Math.round(width * .008))}"/><circle cx="${Math.round(width * .9)}" cy="${Math.round(height * .17)}" r="${Math.max(3, Math.round(width * .006))}"/></g><g stroke="#ffd54d" stroke-width="${Math.max(3, Math.round(width * .005))}" stroke-linecap="round" opacity=".86"><path d="M${Math.round(width * .12)} ${Math.round(height * .17)} l${Math.round(width * .035)} -${Math.round(height * .026)}"/><path d="M${Math.round(width * .84)} ${Math.round(height * .06)} l${Math.round(width * .035)} ${Math.round(height * .025)}"/></g></svg>`)
      : Buffer.from(`<svg width="${width}" height="${height}"><defs><radialGradient id="focus"><stop stop-color="#071521" stop-opacity=".30"/><stop offset="1" stop-color="#071521" stop-opacity="0"/></radialGradient></defs><ellipse cx="${align === "left" ? Math.round(width * .24) : Math.round(width * .5)}" cy="${Math.round(height * .08)}" rx="${Math.round(width * .48)}" ry="${Math.round(height * .28)}" fill="url(#focus)"/><path d="M${titleLeft} ${Math.round(height * .043)} h${Math.round(width * .08)}" stroke="#7dd3fc" stroke-width="${Math.max(4, Math.round(height * .005))}" stroke-linecap="round"/></svg>`);
  const layers: Array<{ input: Buffer; left?: number; top?: number }> = [{ input: decorative }];
  for (const [index, line] of lines.entries()) {
    const top = titleTop + index * (lineHeight + lineGap);
    const createLine = async (color: string) => coverSharp({ text: {
      text: `<span foreground="${color}" weight="heavy">${escapeMarkup(line)}</span>`,
      font: font.family, fontfile: font.path, width: titleWidth, height: lineHeight, align, rgba: true,
    } }).png().toBuffer({ resolveWithObject: true });
    const strokeLayer = await createLine(stroke);
    const shadowLayer = await createLine(shadow);
    const fillLayer = await createLine(palettes[profile][index % palettes[profile].length]);
    layers.push({ input: shadowLayer.data, left: titleLeft + outline * 2, top: top + outline * 3 });
    for (const [offsetX, offsetY] of [[-outline, 0], [outline, 0], [0, -outline], [0, outline], [-outline, -outline], [outline, outline]] as const) {
      layers.push({ input: strokeLayer.data, left: titleLeft + offsetX, top: top + offsetY });
    }
    if (profile === "funny-cartoon") layers.push({ input: fillLayer.data, left: titleLeft - Math.max(1, Math.round(outline / 2)), top: top - Math.max(1, Math.round(outline / 2)) });
    layers.push({ input: fillLayer.data, left: titleLeft, top });
  }
  if (plan.subtitle) {
    const subtitleTop = Math.min(Math.round(height * 0.42), titleTop + lines.length * (lineHeight + lineGap) + Math.round(height * 0.012));
    const subtitleHeight = Math.max(24, Math.round(height * (portrait ? 0.05 : 0.065)));
    const subtitleWidth = Math.min(titleWidth, Math.round(width * (portrait ? 0.72 : 0.52)));
    const subtitleColor = profile === "funny-cartoon" ? "#fff8de" : profile === "story-cartoon" ? "#fff4d0" : "#ffffff";
    const subtitle = await coverSharp({ text: {
      text: `<span foreground="${subtitleColor}" weight="bold">${escapeMarkup(plan.subtitle)}</span>`, font: font.family, fontfile: font.path,
      width: subtitleWidth, height: subtitleHeight, align, rgba: true,
    } }).png().toBuffer({ resolveWithObject: true });
    const subtitleStroke = await coverSharp({ text: {
      text: `<span foreground="${stroke}" weight="bold">${escapeMarkup(plan.subtitle)}</span>`, font: font.family, fontfile: font.path,
      width: subtitleWidth, height: subtitleHeight, align, rgba: true,
    } }).png().toBuffer({ resolveWithObject: true });
    const subtitleLeft = align === "left" ? titleLeft : Math.floor((width - subtitle.info.width) / 2);
    const subtitleOutline = Math.max(1, Math.round(outline * 0.6));
    layers.push({ input: subtitleStroke.data, left: subtitleLeft + subtitleOutline, top: subtitleTop + subtitleOutline * 2 });
    layers.push({ input: subtitle.data, left: subtitleLeft, top: subtitleTop });
  }
  const bytes = await coverSharp(background).composite(layers).png({ compressionLevel: 9 }).toBuffer();
  return {
    bytes, width, height, sourceWidth, sourceHeight, compositionProfile: profile,
    renderedText: { title: plan.title, subtitle: plan.subtitle, lines },
  };
}
