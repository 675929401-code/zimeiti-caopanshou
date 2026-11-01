/** Exact per-panel glyphs are rendered by the platform, never invented by the image provider. */
export const STORYBOARD_ANNOTATION_TEXT_PREFIX = "STORYBOARD_ANNOTATIONS_V1";
export const STORYBOARD_ANNOTATION_TEXT_PREFIX_V2 = "STORYBOARD_ANNOTATIONS_V2";
export const STORYBOARD_ANNOTATION_TEXT_MAX_LENGTH = 2048;
export type StoryboardAnnotationPanel = { caption?: string; shot: number; camera: string; action: string };
export type StoryboardAnnotationLayout = { status: "none" | "invalid" | "valid"; error?: string; exactText?: string; panels?: StoryboardAnnotationPanel[] };
const FIELD_CONTROL = /[\x00-\x1f\x7f]/u;
const TEXT_CONTROL = /[\x00-\x09\x0b\x0c\x0e-\x1f\x7f]/u;
const ORDINARY_TEXT_CONTROL = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/u;
const ENGLISH = /^[\x20-\x7e]+$/u;
const SHOT = /^SHOT\s+(\d+)\s*\|\s*CAMERA:\s*(.+)$/iu;
const ACTION = /^ACTION:\s*(.+)$/iu;

function validField(value: unknown, maximum: number, english = false): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= maximum
    && !FIELD_CONTROL.test(value) && (!english || ENGLISH.test(value));
}
function validPanel(value: unknown, captionRequired: boolean): value is StoryboardAnnotationPanel {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return Object.keys(row).every(key => ["caption", "shot", "camera", "action"].includes(key))
    && Number.isSafeInteger(row.shot) && Number(row.shot) > 0
    && validField(row.camera, 120, true) && validField(row.action, 120, true)
    && (captionRequired ? validField(row.caption, 80) : row.caption === undefined || validField(row.caption, 80));
}
function parseV1Panels(value: string, strictFields = true): StoryboardAnnotationPanel[] | null {
  const lines = value.replace(/\r\n/gu, "\n").trim().split("\n");
  if (lines[0] !== STORYBOARD_ANNOTATION_TEXT_PREFIX || lines.length < 3 || lines.length > 9 || lines.length % 2 !== 1) return null;
  const panels: StoryboardAnnotationPanel[] = [];
  for (let index = 1; index < lines.length; index += 2) {
    const shot = (strictFields ? SHOT : /^SHOT\s*(\d+)\s*\|\s*CAMERA\s*:\s*(.+)$/iu).exec(lines[index].trim());
    const action = (strictFields ? ACTION : /^ACTION\s*:\s*(.+)$/iu).exec(lines[index + 1].trim());
    if (!shot || !action) return null;
    const panel = { shot: Number(shot[1]), camera: shot[2], action: action[1] };
    if (strictFields ? !validPanel(panel, false)
      : !Number.isSafeInteger(panel.shot) || panel.shot <= 0 || !panel.camera.trim() || !panel.action.trim()
        || FIELD_CONTROL.test(panel.camera + panel.action)) return null;
    panels.push(panel);
  }
  return panels;
}
/** Read-only compatibility for already accepted V1 requests. Never authorizes a new submission. */
export function parseAcceptedLegacyStoryboardAnnotationPanels(value: unknown): StoryboardAnnotationPanel[] | null {
  return typeof value === "string" && value.length <= 200 && !TEXT_CONTROL.test(value) ? parseV1Panels(value, false) : null;
}
/** Typed payloads require exactly four panels; partial payloads never get trimmed into validity. */
export function parseStoryboardAnnotationPanels(value: unknown): StoryboardAnnotationPanel[] | null {
  if (typeof value !== "string" || value.length > STORYBOARD_ANNOTATION_TEXT_MAX_LENGTH || TEXT_CONTROL.test(value)) return null;
  const normalized = value.replace(/\r\n/gu, "\n").trim();
  if (normalized.startsWith(`${STORYBOARD_ANNOTATION_TEXT_PREFIX_V2}\n`)) {
    try {
      const parsed: unknown = JSON.parse(normalized.slice(STORYBOARD_ANNOTATION_TEXT_PREFIX_V2.length + 1));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || Object.keys(parsed).some(key => key !== "panels")) return null;
      const panels = (parsed as { panels?: unknown }).panels;
      if (!Array.isArray(panels) || panels.length !== 4 || !panels.every(panel => validPanel(panel, true))) return null;
      return panels.map(panel => ({ caption: panel.caption, shot: panel.shot, camera: panel.camera, action: panel.action }));
    } catch { return null; }
  }
  const panels = parseV1Panels(normalized);
  return panels?.length === 4 ? panels : null;
}
export function isValidImageExactText(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (/^STORYBOARD_ANNOTATIONS_/iu.test(value.trimStart())) return parseStoryboardAnnotationPanels(value) !== null;
  return value.length <= 200 && !ORDINARY_TEXT_CONTROL.test(value);
}
export function isRestorableImageExactText(value: unknown): value is string {
  return isValidImageExactText(value) || parseAcceptedLegacyStoryboardAnnotationPanels(value) !== null;
}
export function resolveStoryboardAnnotationLayout(prompt: string): StoryboardAnnotationLayout {
  const value = String(prompt || "");
  const invalid = (): StoryboardAnnotationLayout => ({ status: "invalid", error: "故事板注释必须是按画格顺序出现的完整四组：引号内原中文、SHOT/CAMERA、ACTION；请修复后再提交。" });
  if (/^STORYBOARD_ANNOTATIONS_/iu.test(value.trimStart())) {
    const panels = parseStoryboardAnnotationPanels(value);
    return panels ? { status: "valid", exactText: value.trim(), panels } : invalid();
  }
  if (!/(?:底栏三行|STORYBOARD_ANNOTATIONS_|\bSHOT\s*\d*\s*\||^\s*ACTION\s*:)/imu.test(value)) return { status: "none" };
  if (TEXT_CONTROL.test(value)) return invalid();
  const lines = value.split(/\r?\n/u).map(line => line.trim());
  const panels: StoryboardAnnotationPanel[] = [];
  const actions = new Set<number>();
  for (let index = 0; index < lines.length; index++) {
    if (!/^SHOT\b/iu.test(lines[index])) continue;
    const shot = SHOT.exec(lines[index]), action = ACTION.exec(lines[index + 1] || "");
    const quoted = /^(?:“([^”]*)”|"([^"]*)")$/u.exec(lines[index - 1] || "");
    if (!shot || !action || !quoted) return invalid();
    const panel = { caption: quoted[1] ?? quoted[2], shot: Number(shot[1]), camera: shot[2], action: action[1] };
    if (!validPanel(panel, true)) return invalid();
    panels.push(panel); actions.add(index + 1);
  }
  if (panels.length !== 4 || lines.some((line, index) => /^ACTION\b/iu.test(line) && !actions.has(index))) return invalid();
  const exactText = `${STORYBOARD_ANNOTATION_TEXT_PREFIX_V2}\n${JSON.stringify({ panels })}`;
  if (!isValidImageExactText(exactText)) return invalid();
  return { status: "valid", exactText, panels };
}
export function storyboardAnnotationTextForPrompt(prompt: string): string | undefined {
  const result = resolveStoryboardAnnotationLayout(prompt);
  return result.status === "valid" ? result.exactText : undefined;
}
/** Legacy consumers receive English pairs; V2-aware consumers use parseStoryboardAnnotationPanels. */
export function parseStoryboardAnnotationText(value: string): string[] | null {
  const panels = parseStoryboardAnnotationPanels(value);
  return panels ? panels.flatMap(panel => [`SHOT ${String(panel.shot).padStart(2, "0")} | CAMERA: ${panel.camera}`, `ACTION: ${panel.action}`]) : null;
}
