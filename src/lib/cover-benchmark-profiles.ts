/** Compatibility metadata only. Complete prompts and provenance are server-only. */
import { COVER_BUILTIN_STYLE_METADATA } from "./cover-style-catalog";
export const COVER_BENCHMARK_STYLE_PROFILES = COVER_BUILTIN_STYLE_METADATA.map(meta => ({
  key: meta.styleKey, version: "3.0.0", displayName: meta.displayName,
  researchSources: [], visualGrammar: [], palette: ["neutral"],
  typography: { profile: meta.styleKey === "funny-cartoon" ? "high_contrast_reaction" : "warm_story",
    maxLines: 2 as const, respectExplicitLineBreaks: true as const },
}));
