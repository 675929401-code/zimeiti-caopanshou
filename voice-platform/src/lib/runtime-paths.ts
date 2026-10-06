import path from "node:path";

type RuntimeEnvironment = Readonly<Record<string, string | undefined>>;

export function resolveReferenceAudioDirectory(
  environment: RuntimeEnvironment = process.env,
  cwd = process.cwd(),
): string {
  const configured = environment.VOICE_REFERENCE_AUDIO_DIR?.trim();
  const production = environment.NODE_ENV === "production";
  if (production && (!configured || !path.isAbsolute(configured))) {
    throw new Error("VOICE_REFERENCE_AUDIO_DIR must be an absolute persistent path in production");
  }
  return path.resolve(configured || path.join(cwd, "public", "reference-audio"));
}

export function referenceAudioPublicUrl(filename: string): string {
  return `/voice-platform/reference-audio/${encodeURIComponent(filename)}`;
}
