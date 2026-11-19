const internationalPlatforms = new Set(["youtube", "tiktok", "twitter", "facebook", "instagram", "threads", "pinterest", "linkedin"]);

export type PublishingProviderEnvironment = "domestic" | "international";

export function providerEnvironmentForPlatform(platform: string): PublishingProviderEnvironment {
  return internationalPlatforms.has(platform) ? "international" : "domestic";
}
