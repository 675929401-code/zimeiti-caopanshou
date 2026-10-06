import { NextRequest, NextResponse } from "next/server";
import { execFile } from "child_process";
import { promisify } from "util";
import { readFile, stat } from "fs/promises";
import { existsSync } from "fs";
import path from "path";
import { atomicWriteJson } from "@/lib/atomic-file";
import { assertAuthSnapshotUsable, validateAuthSnapshotUsers } from "@/lib/auth-snapshot-guard";
import { verifyAdminToken } from "@/lib/admin-auth";
import { resolveBackupDir } from "@/lib/runtime-paths";

const execFileAsync = promisify(execFile);
const BACKUP_SCRIPT_PATH = process.platform === "win32"
  ? "runtime-tools\\backup-data.sh"
  : "runtime-tools/backup-data.sh";

/* 管理员验证 */
async function verifyAdmin(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) return null;
  const token = authHeader.slice(7);
  const actor = await verifyAdminToken(token);
  return actor?.userId ?? null;
}

/* 备份文件路径 */
function getBackupDir() {
  return resolveBackupDir();
}
function getBackupFile() {
  return path.join(getBackupDir(), "latest.json");
}
function getTimestampFile() {
  return path.join(getBackupDir(), "latest.timestamp");
}

/* ─────────── GET: 查询备份状态 ─────────── */
export async function GET(req: NextRequest) {
  if (!(await verifyAdmin(req))) {
    return NextResponse.json({ error: "无权限" }, { status: 403 });
  }

  try {
    const backupFile = getBackupFile();
    const timestampFile = getTimestampFile();

    if (!existsSync(backupFile)) {
      return NextResponse.json({
        exists: false,
        message: "暂无备份",
      });
    }

    const fileStat = await stat(backupFile);
    const timestamp = existsSync(timestampFile) ? (await readFile(timestampFile, "utf-8")).trim() : "未知";

    /* 读取备份文件元信息（不读取全部内容） */
    const content = await readFile(backupFile, "utf-8");
    const data = JSON.parse(content);

    /* 统计各表记录数 */
    const tableCounts: Record<string, number> = {};
    for (const category of ["core", "config", "logs"]) {
      const tables = data[category] || {};
      for (const [tableName, rows] of Object.entries(tables)) {
        tableCounts[tableName] = Array.isArray(rows) ? rows.length : 0;
      }
    }

    /* 核心资产统计 */
    const users = data.core?.users || [];
    const authSnapshot = validateAuthSnapshotUsers(users);
    const totalCredits = users.reduce((sum: number, u: Record<string, unknown>) => sum + ((u.credits as number) || 0), 0);
    const totalCash = users.reduce((sum: number, u: Record<string, unknown>) => sum + ((u.cash_balance as number) || 0), 0);

    return NextResponse.json({
      exists: true,
      backupTime: data.backup_time || timestamp,
      dateLabel: data.date_label,
      version: data.version,
      fileSize: `${(fileStat.size / 1024).toFixed(1)} KB`,
      tableCounts,
      authSnapshot,
      summary: {
        userCount: users.length,
        totalCredits: Math.round(totalCredits),
        totalCash: Math.round(totalCash * 100) / 100,
      },
    });
  } catch (error) {
    console.error("查询备份状态失败:", error);
    return NextResponse.json({ error: "查询备份状态失败" }, { status: 500 });
  }
}

/* ─────────── POST: 手动触发备份 ─────────── */
export async function POST(req: NextRequest) {
  if (!(await verifyAdmin(req))) {
    return NextResponse.json({ error: "无权限" }, { status: 403 });
  }

  if (process.env.NODE_ENV === "production") {
    return NextResponse.json({
      error: "生产备份由独立定时任务执行，Web 进程禁止启动备份脚本。",
      code: "EXTERNAL_BACKUP_SCHEDULER_REQUIRED",
    }, { status: 409 });
  }

  try {
    const scriptPath = BACKUP_SCRIPT_PATH;

    /* 确保脚本存在 */
    if (!existsSync(scriptPath)) {
      return NextResponse.json({ error: "备份脚本不存在" }, { status: 500 });
    }

    /* 执行备份脚本 */
    const { stdout, stderr } = await execFileAsync("bash", [scriptPath], {
      timeout: 120000, // 2分钟超时
      env: { ...process.env },
    });

    console.log("备份脚本输出:", stdout);
    if (stderr) console.log("备份脚本错误:", stderr);

    /* 读取备份结果 */
    const backupFile = getBackupFile();
    if (!existsSync(backupFile)) {
      return NextResponse.json({ error: "备份执行完成但文件未生成" }, { status: 500 });
    }

    const content = await readFile(backupFile, "utf-8");
    const data = JSON.parse(content);
    const authSnapshot = assertAuthSnapshotUsable(data.core?.users, "自动备份结果");
    data.auth_snapshot = authSnapshot;
    await atomicWriteJson(backupFile, data);
    const fileStat = await stat(backupFile);

    const users = data.core?.users || [];
    const totalCredits = users.reduce((sum: number, u: Record<string, unknown>) => sum + ((u.credits as number) || 0), 0);
    const totalCash = users.reduce((sum: number, u: Record<string, unknown>) => sum + ((u.cash_balance as number) || 0), 0);

    return NextResponse.json({
      success: true,
      message: "备份完成",
      backupTime: data.backup_time,
      fileSize: `${(fileStat.size / 1024).toFixed(1)} KB`,
      authSnapshot,
      summary: {
        userCount: users.length,
        totalCredits: Math.round(totalCredits),
        totalCash: Math.round(totalCash * 100) / 100,
      },
    });
  } catch (error) {
    console.error("手动备份失败:", error);
    return NextResponse.json({ error: "备份执行失败: " + (error instanceof Error ? error.message : String(error)) }, { status: 500 });
  }
}
