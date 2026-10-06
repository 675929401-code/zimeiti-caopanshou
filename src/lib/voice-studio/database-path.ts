import path from "node:path";

/**
 * The Voice SQLite database is mutable runtime state. Production must inject
 * one absolute, persistent path shared by the Web admin/pricing code and the
 * isolated Voice service. A missing production setting is an error so a new
 * empty database can never be created inside an immutable release directory.
 */
export function resolveVoiceSqlitePath(
  environment: Readonly<Record<string, string | undefined>> = process.env,
  workingDirectory = process.cwd(),
): string {
  const configuredPath = environment.VOICE_SQLITE_PATH?.trim();
  if (configuredPath) {
    if (configuredPath.startsWith("file:")) {
      throw new Error("VOICE_SQLITE_PATH must be a filesystem path, not a Prisma file: URL");
    }
    if (environment.NODE_ENV === "production" && !path.isAbsolute(configuredPath)) {
      throw new Error("VOICE_SQLITE_PATH must be absolute in production");
    }
    return path.resolve(/* turbopackIgnore: true */ workingDirectory, configuredPath);
  }

  if (environment.NODE_ENV === "production") {
    throw new Error("VOICE_SQLITE_PATH is required in production");
  }
  return path.join(/* turbopackIgnore: true */ workingDirectory, "voice-platform", "prisma", "dev.db");
}
