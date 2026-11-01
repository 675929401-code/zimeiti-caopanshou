import type { StoryboardReferenceImageSettings } from './storyboard-visual-asset-workspace';

/** Resolve new reference requests against the selected model; stored request receipts remain frozen. */
export function resolveStoryboardReferenceImageSettings(settings: StoryboardReferenceImageSettings, capabilities: {
  resolutionOptions: readonly string[];
  defaultResolution: string;
  aspectRatios: readonly StoryboardReferenceImageSettings['ratio'][];
}): StoryboardReferenceImageSettings {
  const resolution = capabilities.resolutionOptions.includes(settings.resolution) ? settings.resolution
    : capabilities.resolutionOptions.includes(capabilities.defaultResolution) ? capabilities.defaultResolution
      : capabilities.resolutionOptions[0] || settings.resolution;
  const ratio = capabilities.aspectRatios.includes(settings.ratio) ? settings.ratio
    : capabilities.aspectRatios.includes('16:9') ? '16:9'
      : capabilities.aspectRatios.includes('1:1') ? '1:1'
        : capabilities.aspectRatios[0] || settings.ratio;
  return resolution === settings.resolution && ratio === settings.ratio ? settings : { ...settings, resolution, ratio };
}
