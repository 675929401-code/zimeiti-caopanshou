import fs from "node:fs";

const studioScript = "scripts/upgrade-cover-studio-v2.mjs";
let source = fs.readFileSync(studioScript, "utf8");
const fixes = [
  ['      扩图: `Extend and recompose this image naturally for a ${canvasWidth}:${canvasHeight} cover. Preserve the main subject identity and leave clean typography space. No text.`,', '      扩图: \\`Extend and recompose this image naturally for a \\${canvasWidth}:\\${canvasHeight} cover. Preserve the main subject identity and leave clean typography space. No text.\\`,'],
  ['      换背景: `${prompt}. Keep the main subject identity and pose, replace the environment with this new scene, premium commercial cover background, no text.`,', '      换背景: \\`\\${prompt}. Keep the main subject identity and pose, replace the environment with this new scene, premium commercial cover background, no text.\\`,'],
  ['headers: { Authorization: `Bearer ${token}`,', 'headers: { Authorization: \\`Bearer \\${token}\\`,'],
  ['      setNotice(`AI ${action}已完成`);', '      setNotice(\\`AI \\${action}已完成\\`);'],
  ['      setNotice(error instanceof Error ? error.message : `AI ${action}失败`);', '      setNotice(error instanceof Error ? error.message : \\`AI \\${action}失败\\`);'],
  ['<span>{sidebarMode === "templates" ? `${filteredTemplates.length} 款` : `${candidates.length} 项`}</span>', '<span>{sidebarMode === "templates" ? \\`\\${filteredTemplates.length} 款\\` : \\`\\${candidates.length} 项\\`}</span>'],
];
for (const [search, replacement] of fixes) {
  if (!source.includes(search)) throw new Error(`Missing repair anchor: ${search.slice(0, 40)}`);
  source = source.replace(search, replacement);
}
fs.writeFileSync(studioScript, source, "utf8");

const canvasFile = "src/components/cover-canvas.tsx";
let canvas = fs.readFileSync(canvasFile, "utf8");
canvas = canvas.replace('      const tagged = withRole(object, roleOf(object) ?? "decoration");', '      const tagged = withRole(object, roleOf(object) ?? "decoration") as TaggedObject;');
fs.writeFileSync(canvasFile, canvas, "utf8");
console.log("Repaired V2 upgrade script and canvas metadata typing");
