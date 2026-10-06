import fs from "node:fs/promises";
import { atomicWriteJson } from "@/lib/atomic-file";
import { createDefaultStudioConfig, StudioRuntimeConfigSchema, type StudioRuntimeConfig } from "@/lib/studio-config-schema";
import {
  isProductionRuntime,
  resolveAppDataFileWithOverride,
} from "@/lib/runtime-paths";

function resolveStudioConfigPath(): string {
  return resolveAppDataFileWithOverride(
    "studio-config.json",
    "STUDIO_CONFIG_PATH",
  );
}

export async function readStudioConfig(): Promise<StudioRuntimeConfig> {
  const configPath = resolveStudioConfigPath();
  try {
    const parsed = StudioRuntimeConfigSchema.safeParse(JSON.parse(
      await fs.readFile(/* turbopackIgnore: true */ configPath, "utf8"),
    ));
    if (parsed.success) return parsed.data;
  } catch (error) {
    if (isProductionRuntime()) throw error;
  }
  if (isProductionRuntime()) {
    throw new Error(`Runtime studio config is invalid: ${configPath}`);
  }
  return createDefaultStudioConfig();
}

export async function writeStudioConfig(input: unknown): Promise<StudioRuntimeConfig> {
  const configPath = resolveStudioConfigPath();
  const parsed = StudioRuntimeConfigSchema.parse(input);
  const config: StudioRuntimeConfig = {
    ...parsed,
    promptTemplates: parsed.promptTemplates.map((template) => ({ ...template, updatedAt: new Date().toISOString() })),
    updatedAt: new Date().toISOString(),
  };
  await atomicWriteJson(configPath, config, { trailingNewline: true });
  return config;
}

export function activeBrainPrompt(config: StudioRuntimeConfig): string {
  return config.promptTemplates.find((template) => template.id === config.brainTemplateId)?.content
    || config.promptTemplates[0].content;
}
