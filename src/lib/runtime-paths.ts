import fs from "node:fs";
import path from "node:path";

type RuntimeEnvironment = Readonly<Record<string, string | undefined>>;

const READ_WRITE = fs.constants.R_OK | fs.constants.W_OK;

export function isProductionRuntime(
  environment: RuntimeEnvironment = process.env,
): boolean {
  return environment.NODE_ENV === "production";
}

function assertSafeDirectory(directory: string, label: string): void {
  if (path.parse(directory).root === directory) {
    throw new Error(`${label} cannot be the filesystem root`);
  }
}

function ensureReadableWritableDirectory(
  directory: string,
  label: string,
  environment: RuntimeEnvironment,
): string {
  assertSafeDirectory(directory, label);

  if (!fs.existsSync(/* turbopackIgnore: true */ directory)) {
    if (isProductionRuntime(environment)) {
      throw new Error(`${label} does not exist in production: ${directory}`);
    }
    fs.mkdirSync(/* turbopackIgnore: true */ directory, { recursive: true });
  }

  let stats: fs.Stats;
  try {
    stats = fs.statSync(/* turbopackIgnore: true */ directory);
  } catch {
    throw new Error(`${label} cannot be inspected: ${directory}`);
  }
  if (!stats.isDirectory()) {
    throw new Error(`${label} must be a directory: ${directory}`);
  }

  try {
    fs.accessSync(/* turbopackIgnore: true */ directory, READ_WRITE);
  } catch {
    throw new Error(`${label} must be readable and writable: ${directory}`);
  }
  return directory;
}

function resolveRuntimeDirectory(
  environmentVariable: "APP_DATA_DIR" | "APP_RUNTIME_DIR" | "IDEMPOTENCY_DIR" | "BACKUP_DIR",
  developmentFallback: string,
  environment: RuntimeEnvironment,
  workingDirectory: string,
): string {
  const configured = environment[environmentVariable]?.trim();
  if (!configured && isProductionRuntime(environment)) {
    throw new Error(`${environmentVariable} is required in production`);
  }
  if (configured && isProductionRuntime(environment) && !path.isAbsolute(configured)) {
    throw new Error(`${environmentVariable} must be absolute in production`);
  }

  const directory = configured
    ? path.resolve(/* turbopackIgnore: true */ workingDirectory, configured)
    : path.join(/* turbopackIgnore: true */ workingDirectory, developmentFallback);
  return ensureReadableWritableDirectory(directory, environmentVariable, environment);
}

export function resolveAppDataDir(
  environment: RuntimeEnvironment = process.env,
  workingDirectory = process.cwd(),
): string {
  return resolveRuntimeDirectory(
    "APP_DATA_DIR",
    "data",
    environment,
    workingDirectory,
  );
}

export function resolveAppDataFile(
  fileName: string,
  environment: RuntimeEnvironment = process.env,
  workingDirectory = process.cwd(),
): string {
  if (!fileName || fileName !== path.basename(fileName) || fileName === "." || fileName === "..") {
    throw new Error(`Runtime data file name is invalid: ${fileName}`);
  }
  return path.join(/* turbopackIgnore: true */ resolveAppDataDir(environment, workingDirectory), fileName);
}

export function resolveAppDataFileWithOverride(
  fileName: string,
  overrideEnvironmentVariable: string,
  environment: RuntimeEnvironment = process.env,
  workingDirectory = process.cwd(),
): string {
  const configured = environment[overrideEnvironmentVariable]?.trim();
  if (!configured) {
    return resolveAppDataFile(fileName, environment, workingDirectory);
  }
  if (isProductionRuntime(environment) && !path.isAbsolute(configured)) {
    throw new Error(`${overrideEnvironmentVariable} must be absolute in production`);
  }

  const filePath = path.resolve(/* turbopackIgnore: true */ workingDirectory, configured);
  ensureReadableWritableDirectory(
    path.dirname(/* turbopackIgnore: true */ filePath),
    `${overrideEnvironmentVariable} parent directory`,
    environment,
  );
  return filePath;
}

export function resolveAppRuntimeDir(
  environment: RuntimeEnvironment = process.env,
  workingDirectory = process.cwd(),
): string {
  return resolveRuntimeDirectory(
    "APP_RUNTIME_DIR",
    ".logs",
    environment,
    workingDirectory,
  );
}

export function resolveBackupDir(
  environment: RuntimeEnvironment = process.env,
  workingDirectory = process.cwd(),
): string {
  return resolveRuntimeDirectory(
    "BACKUP_DIR",
    "backups",
    environment,
    workingDirectory,
  );
}

export function resolveIdempotencyDir(
  environment: RuntimeEnvironment = process.env,
  workingDirectory = process.cwd(),
): string {
  const configured = environment.IDEMPOTENCY_DIR?.trim();
  if (configured) {
    return resolveRuntimeDirectory(
      "IDEMPOTENCY_DIR",
      path.join(/* turbopackIgnore: true */ ".logs", "llm-request-idempotency"),
      environment,
      workingDirectory,
    );
  }

  const directory = path.join(
    /* turbopackIgnore: true */
    resolveAppRuntimeDir(environment, workingDirectory),
    "llm-request-idempotency",
  );
  return ensureReadableWritableDirectory(directory, "IDEMPOTENCY_DIR", environment);
}
