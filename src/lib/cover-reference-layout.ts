import type { CoverTitleStyle } from "@/lib/cover-composition";
import type { CoverPrepareInput, CoverVisualObservation } from "@/lib/cover-workbench-contract";
import { coverMaterialsWithUsage, type CoverMaterialUsage } from "@/lib/cover-material-usage";

type Region = { x: number; y: number; width: number; height: number };
const clamp = (value: number, lower: number, upper: number) => Math.max(lower, Math.min(upper, value));
function overlap(a: Region, b: Region) {
  return Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x))
    * Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y)) / (a.width * a.height);
}
function luminance(color: string) {
  const channels = [1, 3, 5].map(start => {
    const value = Number.parseInt(color.slice(start, start + 2), 16) / 255;
    return value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4;
  });
  return .2126 * channels[0] + .7152 * channels[1] + .0722 * channels[2];
}
function contrast(left: string, right: string) {
  const a = luminance(left), b = luminance(right);
  return (Math.max(a, b) + .05) / (Math.min(a, b) + .05);
}

/** Adapt observed reference typography to a preserved photograph. Image
 * identity stays in its original layer; this only chooses editable text data. */
export function coverReferenceTitleStyle(input: {
  materials: CoverPrepareInput; observations: readonly CoverVisualObservation[]; sourceAssetId?: string; materialUsage?: CoverMaterialUsage;
}): CoverTitleStyle {
  const style: CoverTitleStyle = { x: .08, y: .07, width: .84, scale: 1 };
  const binding = coverMaterialsWithUsage(input.materials, input.materialUsage).assets.find(asset => asset.role === "style_reference");
  const reference = input.observations.find(observation => observation.assetId === binding?.assetId && observation.status === "ready");
  if (!reference) return style;
  const original = input.observations.find(observation => observation.assetId === input.sourceAssetId && observation.status === "ready");
  const subjects = original?.observations.filter(observation => observation.kind === "subject" && observation.region).map(observation => observation.region!) || [];
  const preferred = reference.observations.find(observation => observation.kind === "title_zone" && observation.region)?.region;
  const sourceSpaces = original?.observations.filter(observation => observation.kind === "negative_space" && observation.region).map(observation => observation.region!) || [];
  const usable = (region: Region) => region.width >= .2 && region.y <= .5 && subjects.every(subject => overlap(region, subject) < .15);
  const zone = preferred && usable(preferred) ? preferred : sourceSpaces.find(usable);
  if (zone) {
    style.x = clamp(zone.x, .02, .7);
    style.y = clamp(zone.y, .02, .5);
    style.width = clamp(zone.width, .2, .98 - style.x);
  }
  const background = original?.palette[0];
  if (background) {
    const colors = reference.palette.map(color => ({ color, contrast: contrast(color, background) })).sort((a, b) => b.contrast - a.contrast);
    const choice = colors[0]?.contrast >= 4.5 ? colors[0].color
      : contrast("#ffffff", background) >= contrast("#000000", background) ? "#ffffff" : "#000000";
    style.color = choice;
  }
  return style;
}
