import fs from "node:fs";
import path from "node:path";

const defaultSource = "E:\\BaiduNetdiskDownload\\T162剪映高级感万能行业短视频封面字幕排版预设视频花字剪辑\\剪映封面预设合集\\封面预设";
const sourceRoot = process.env.JIANYING_COVER_PRESETS || defaultSource;
const projectRoot = process.cwd();
const previewRoot = path.join(projectRoot, "public", "cover-presets");
const outputFile = path.join(projectRoot, "src", "lib", "jianying-cover-templates.generated.json");

function walk(directory, result = []) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) walk(fullPath, result);
    else if (entry.name === "draft_content.json") result.push(fullPath);
  }
  return result;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function colorToHex(value, fallback = "#ffffff") {
  if (typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value)) return value;
  if (!Array.isArray(value) || value.length < 3) return fallback;
  return `#${value.slice(0, 3).map((part) => Math.round(Math.max(0, Math.min(1, Number(part))) * 255).toString(16).padStart(2, "0")).join("")}`;
}

function contentInfo(material) {
  try {
    const parsed = JSON.parse(material.content || "{}");
    return { text: parsed.text || material.base_content || "文字", styles: parsed.styles || [] };
  } catch {
    return { text: material.base_content || material.content || "文字", styles: [] };
  }
}

function fontFamily(fileName) {
  if (/宋|serif|song/i.test(fileName)) return '"SimSun", "STSong", serif';
  if (/楷|手写|行楷|书|kai/i.test(fileName)) return '"KaiTi", "STKaiti", cursive';
  return '"Microsoft YaHei", "PingFang SC", sans-serif';
}

function categoryFor(name, series) {
  if (/职场|老板|面试|工作|高管/.test(name)) return "职场";
  if (/教程|剪辑|知识|分点|指南|方法/.test(name)) return "教程";
  if (/人物|介绍|人设|口播|博客|VLOG/i.test(name)) return "口播";
  return series.startsWith("A") ? "大字排版" : series.startsWith("B") ? "行业封面" : "组合排版";
}

function makeLayer(material, segment, index) {
  const { text, styles } = contentInfo(material);
  const style = styles[0] || {};
  const fill = colorToHex(style?.fill?.content?.solid?.color, material.text_color || "#ffffff");
  const fontFile = path.basename(material.font_path || style?.font?.path || "");
  const transform = segment.clip?.transform || {};
  const scale = segment.clip?.scale || {};
  const shadow = style?.shadows?.[0] || null;
  const shadowColor = colorToHex(shadow?.content?.solid?.color, material.shadow_color || "#000000");
  const lineMaxWidth = Number(material.line_max_width);
  const baseSize = Number(style.size || material.font_size || material.text_size || 24);
  const borderColor = material.border_color || style?.stroke?.content?.solid?.color;

  return {
    id: `text-${index + 1}-${material.id}`,
    text,
    x: Math.max(-0.2, Math.min(1.2, (1 + Number(transform.x || 0)) / 2)),
    y: Math.max(-0.2, Math.min(1.2, (1 - Number(transform.y || 0)) / 2)),
    width: lineMaxWidth > 0 && lineMaxWidth <= 1.5 ? lineMaxWidth : 0.82,
    fontSizeRatio: baseSize / 360,
    fontFamily: fontFamily(fontFile),
    fontFile,
    fontWeight: /bold|heavy|特黑|大黑|粗|黑体1号/i.test(fontFile) ? 900 : 700,
    fill,
    opacity: Number(segment.clip?.alpha ?? material.global_alpha ?? material.text_alpha ?? 1),
    align: Number(material.alignment) === 2 ? "right" : Number(material.alignment) === 1 ? "center" : "left",
    charSpacing: Math.round(Number(material.letter_spacing || 0) * 1000),
    lineHeight: Math.max(0.75, 1 + Number(material.line_spacing || 0) * 0.18),
    angle: Number(segment.clip?.rotation || 0),
    scaleX: Number(scale.x || 1),
    scaleY: Number(scale.y || 1),
    stroke: typeof borderColor === "string" && borderColor ? colorToHex(borderColor, "#000000") : "",
    strokeWidthRatio: typeof borderColor === "string" && borderColor ? Number(material.border_width || 0) : 0,
    shadow: material.has_shadow || shadow ? {
      color: shadowColor,
      opacity: Number(shadow?.alpha ?? material.shadow_alpha ?? 0.45),
      distanceRatio: Number(shadow?.distance ?? material.shadow_distance ?? 2) / 360,
      angle: Number(shadow?.angle ?? material.shadow_angle ?? 45),
      blurRatio: Number(shadow?.diffuse ?? material.shadow_smoothing ?? 0) / 120,
    } : null,
    background: material.background_color || "",
    zIndex: Number(segment.render_index || index),
  };
}

if (!fs.existsSync(sourceRoot)) throw new Error(`Preset source does not exist: ${sourceRoot}`);
fs.mkdirSync(previewRoot, { recursive: true });

const draftFiles = walk(sourceRoot).sort((a, b) => a.localeCompare(b, "zh-CN", { numeric: true }));
const templates = [];

for (const [index, draftFile] of draftFiles.entries()) {
  const presetDirectory = path.dirname(path.dirname(draftFile));
  const series = path.relative(sourceRoot, presetDirectory).split(path.sep)[0];
  const files = fs.readdirSync(presetDirectory);
  const metaFile = files.find((file) => file.endsWith(".json"));
  const previewFile = files.find((file) => /\.(jpe?g|png)$/i.test(file));
  if (!metaFile || !previewFile) continue;

  const outer = readJson(draftFile);
  const draft = outer.materials?.drafts?.[0]?.draft;
  if (!draft) continue;
  const meta = readJson(path.join(presetDirectory, metaFile));
  const width = Number(draft.canvas_config?.width || meta.cover_width || 1440);
  const height = Number(draft.canvas_config?.height || meta.cover_height || 1920);
  const ratio = height >= width ? "3:4" : "4:3";
  const materialMap = new Map((draft.materials?.texts || []).map((item) => [item.id, item]));
  const segments = (draft.tracks || [])
    .filter((track) => track.type === "text")
    .flatMap((track) => track.segments || [])
    .filter((segment) => materialMap.has(segment.material_id))
    .sort((a, b) => Number(a.render_index || 0) - Number(b.render_index || 0));
  const layers = segments.map((segment, layerIndex) => makeLayer(materialMap.get(segment.material_id), segment, layerIndex));
  const previewName = `jy-${String(index + 1).padStart(3, "0")}${path.extname(previewFile).toLowerCase()}`;
  fs.copyFileSync(path.join(presetDirectory, previewFile), path.join(previewRoot, previewName));
  const name = meta.name || path.basename(presetDirectory);

  templates.push({
    id: `jianying-${String(index + 1).padStart(3, "0")}`,
    name,
    category: categoryFor(name, series),
    ratio,
    layout: "jianying",
    image: ratio === "3:4" ? "/cover-assets/creator-portrait.png" : "/cover-assets/business-landscape.png",
    preview: `/cover-presets/${previewName}`,
    accent: "#f4c542",
    secondary: "#e84c38",
    ink: "#111111",
    surface: "#111111",
    titleColor: "#ffffff",
    title: layers[0]?.text || name,
    subtitle: layers[1]?.text || "",
    badge: layers[2]?.text || "",
    originalWidth: width,
    originalHeight: height,
    sourceSeries: series,
    layers,
  });
}

fs.writeFileSync(outputFile, `${JSON.stringify(templates, null, 2)}\n`, "utf8");
console.log(`Imported ${templates.length} Jianying cover templates.`);
console.log(`Generated ${outputFile}`);
console.log(`Copied previews to ${previewRoot}`);
