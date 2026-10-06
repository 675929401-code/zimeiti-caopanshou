import { readFile } from "fs/promises";
import path from "path";

export interface BackupUserRecord {
  id: string;
  username: string;
  password_hash: string | null;
  display_name: string;
  phone: string | null;
  email: string | null;
  role: string;
  credits: number;
  cash_balance?: number | null;
  is_active: boolean;
  status: string | null;
  allowed_categories: string[] | null;
  member_status: string | null;
  member_expires_at?: string | null;
  theme_preference: string | null;
  session_id?: string | null;
}

interface BackupSettingRecord {
  setting_key: string;
  setting_value: string;
}

export type BackupRecord = Record<string, unknown>;

interface BackupSnapshotShape {
  core?: {
    users?: BackupUserRecord[];
    [table: string]: unknown;
  };
  config?: {
    platform_settings?: BackupSettingRecord[];
    [table: string]: unknown;
  };
  logs?: Record<string, unknown>;
  supplement?: Record<string, unknown>;
  platform_settings?: BackupSettingRecord[];
  [table: string]: unknown;
}

let snapshotCache: BackupSnapshotShape | null = null;
let snapshotLoaded = false;

export function canUseLocalBackupSnapshot() {
  return process.env.ENABLE_LOCAL_BACKUP_SNAPSHOT === "1";
}

async function loadSnapshotFile() {
  if (snapshotLoaded) {
    return snapshotCache;
  }

  const backupFile = path.join(process.cwd(), "backups", "latest.json");
  const content = await readFile(backupFile, "utf-8");
  snapshotCache = JSON.parse(content.replace(/^\uFEFF/, "")) as BackupSnapshotShape;
  snapshotLoaded = true;
  return snapshotCache;
}

export async function getBackupUsers(): Promise<BackupUserRecord[]> {
  if (!canUseLocalBackupSnapshot()) {
    return [];
  }

  const snapshot = await loadSnapshotFile();
  return Array.isArray(snapshot?.core?.users) ? snapshot.core.users : [];
}

export async function findBackupUserByLoginInput(input: string): Promise<BackupUserRecord | null> {
  const normalized = input.trim();
  if (!normalized) {
    return null;
  }

  const users = await getBackupUsers();
  return users.find((user) =>
    user.phone === normalized ||
    user.username === normalized ||
    user.email === normalized
  ) || null;
}

export async function findBackupUserById(userId: string): Promise<BackupUserRecord | null> {
  if (!userId) {
    return null;
  }

  const users = await getBackupUsers();
  return users.find((user) => user.id === userId) || null;
}

export async function getBackupPlatformSettings(): Promise<BackupSettingRecord[]> {
  if (!canUseLocalBackupSnapshot()) {
    return [];
  }

  const snapshot = await loadSnapshotFile();
  const scoped = snapshot?.config?.platform_settings;
  if (Array.isArray(scoped) && scoped.length > 0) {
    return scoped;
  }
  return Array.isArray(snapshot?.platform_settings) ? snapshot.platform_settings : [];
}

export async function getBackupTable(tableName: string): Promise<BackupRecord[]> {
  if (!canUseLocalBackupSnapshot()) {
    return [];
  }

  const snapshot = await loadSnapshotFile();
  const value =
    snapshot?.core?.[tableName] ||
    snapshot?.config?.[tableName] ||
    snapshot?.logs?.[tableName] ||
    snapshot?.supplement?.[tableName] ||
    snapshot?.[tableName];

  return Array.isArray(value) ? (value as BackupRecord[]) : [];
}
