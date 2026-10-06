import fs from "node:fs";
import path from "node:path";

const file = path.resolve("src/app/storyboard-workbench/storyboard-workbench.css");
const marker = "/* storyboard compact workspace v2 */";
const source = fs.readFileSync(file, "utf8");
if (source.includes(marker)) throw new Error("compact workspace styles already applied");

const styles = `

${marker}
.sbw-root .sub-page-header > div {
  width: 100%;
  max-width: none;
  height: 54px;
  padding-inline: 12px;
}

.sbw-shell {
  min-height: calc(100vh - 54px);
  grid-template-columns: 264px minmax(0, 1fr);
}

.sbw-model-rail {
  height: calc(100vh - 54px);
  padding: 10px 9px 12px;
  background: color-mix(in srgb, var(--card) 72%, transparent);
  backdrop-filter: blur(18px);
}

.sbw-rail-summary { margin: 0 3px 8px; padding: 0 2px 9px; }
.sbw-model-section > header { min-height: 26px; padding-inline: 4px; }
.sbw-video-model-section > header { margin-top: 7px; padding-top: 7px; }
.sbw-model-list { gap: 5px; padding: 1px 2px 2px; }
.sbw-image-model-list { max-height: 190px; }
.sbw-model-list > button {
  min-height: 50px;
  grid-template-columns: 30px minmax(0, 1fr) auto;
  gap: 7px;
  padding: 6px 7px;
}
.sbw-model-icon { width: 30px; height: 30px; }
.sbw-model-copy strong { font-size: 9px; }
.sbw-model-copy small, .sbw-model-price { font-size: 7px; }

.sbw-workspace { padding-bottom: 68px; }
.sbw-toolbar {
  min-height: 54px;
  gap: 8px;
  padding: 7px 11px;
  box-shadow: 0 8px 26px rgba(0, 0, 0, .11);
}
.sbw-toolbar-settings { flex-wrap: nowrap; gap: 6px; }
.sbw-control-group { min-height: 36px; gap: 6px; padding: 4px 6px; }
.sbw-ratio-control { min-width: 190px; height: 26px; grid-template-columns: repeat(5, minmax(34px, 1fr)); }
.sbw-resolution-select { height: 26px; }
.sbw-toolbar-actions { gap: 5px; }
.sbw-toolbar-actions button, .sbw-media-actions button, .sbw-add-card, .sbw-icon-button,
.sbw-reference-url-row button { min-height: 30px; padding-inline: 8px; font-size: 9px; }

.sbw-workspace-meta { padding: 8px 11px 3px; }
.sbw-shot-grid {
  gap: 10px;
  padding: 7px 11px 16px;
}
.sbw-shot-card {
  border-color: color-mix(in srgb, #8bb5cf 22%, var(--border));
  padding: 8px;
  box-shadow: 0 10px 28px rgba(0, 0, 0, .12);
}
.sbw-card-header { min-height: 32px; gap: 6px; margin-bottom: 6px; }
.sbw-card-index { width: 25px; height: 25px; flex-basis: 25px; }
.sbw-card-title strong { font-size: 10px; }
.sbw-icon-button { width: 24px; min-height: 24px; }

.sbw-prompt-stack { gap: 6px; }
.sbw-prompt-stack label { gap: 3px; }
.sbw-prompt-stack textarea {
  height: 54px;
  min-height: 54px;
  max-height: 108px;
  padding: 6px 7px;
  font-size: 8px;
  line-height: 1.45;
}
.sbw-prompt-stack label:nth-child(2) textarea { height: 48px; min-height: 48px; }

.sbw-reference-section { margin-top: 6px; }
.sbw-section-line { min-height: 20px; }
.sbw-reference-list { gap: 5px; margin: 3px 0 5px; }
.sbw-reference-list > div, .sbw-reference-preview { width: 42px; height: 42px; }
.sbw-reference-drop {
  min-height: 38px;
  flex-direction: row;
  gap: 6px;
  padding: 4px 7px;
}
.sbw-reference-drop svg { width: 13px; height: 13px; }
.sbw-reference-drop strong { font-size: 8px; }
.sbw-reference-drop span { margin-left: auto; font-size: 7px; }
.sbw-reference-url-row { gap: 4px; margin-top: 4px; }
.sbw-reference-url-row input { height: 28px; padding-inline: 7px; font-size: 8px; }
.sbw-reference-url-row button { min-height: 28px; }

.sbw-zone { margin-top: 6px; padding: 6px; }
.sbw-zone-title { min-height: 16px; margin-bottom: 4px; }
.sbw-image-frame { height: 54px; }
.sbw-image-frame:has(img) { height: 150px; }
.sbw-loading-state, .sbw-empty-state { min-height: 54px; }
.sbw-video-stage > video { max-height: 150px; }
.sbw-video-stage.has-result > video { height: 150px; }
.sbw-media-actions { gap: 4px; margin-top: 5px; }
.sbw-media-actions > button:not(.is-command) { width: 29px; flex-basis: 29px; }
.sbw-media-actions button.is-command { justify-content: center; }
.sbw-error-line { margin-top: 5px; font-size: 7px; }

.sbw-add-card { width: calc(100% - 22px); min-height: 36px; margin: 0 11px; }

@media (max-width: 1160px) {
  .sbw-shell { grid-template-columns: 238px minmax(0, 1fr); }
  .sbw-ratio-control { min-width: 166px; }
  .sbw-control-group.is-video { display: none; }
  .sbw-toolbar-actions button { padding-inline: 6px; }
}

@media (max-width: 1020px) {
  .sbw-shot-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .sbw-toolbar { align-items: stretch; flex-direction: column; }
  .sbw-toolbar-actions { justify-content: flex-start; }
}

@media (max-width: 900px) {
  .sbw-shell { display: block; }
  .sbw-model-rail { height: auto; }
  .sbw-control-group.is-video { display: flex; }
  .sbw-toolbar-settings { flex-wrap: wrap; }
}

@media (max-width: 680px) {
  .sbw-shot-grid { grid-template-columns: 1fr; }
  .sbw-reference-drop span { display: none; }
}
`;

fs.writeFileSync(file, `${source.trimEnd()}${styles}\n`, "utf8");
console.log(`Updated ${file}`);
