/**
 * 智音工坊数据库连接工具
 * 直接连接 voice-platform 的 SQLite 数据库，供主站 admin API 使用
 */
import Database from 'better-sqlite3';
import { resolveVoiceSqlitePath } from './database-path';

let _db: Database.Database | null = null;
let _readonlyDb: Database.Database | null = null;

export function getVoiceDb(): Database.Database {
  if (!_db) {
    _db = new Database(resolveVoiceSqlitePath(), {
      readonly: false,
      fileMustExist: process.env.NODE_ENV === 'production',
    });
    _db.pragma('journal_mode = WAL');
  }
  return _db;
}

/** Public and user-facing GET routes must never open SQLite in write mode. */
export function getVoiceReadonlyDb(): Database.Database {
  if (!_readonlyDb) {
    _readonlyDb = new Database(resolveVoiceSqlitePath(), {
      readonly: true,
      fileMustExist: true,
    });
    _readonlyDb.pragma('busy_timeout = 5000');
  }
  return _readonlyDb;
}

/** 查询所有行 */
export function queryAll<T = Record<string, unknown>>(sql: string, params?: unknown[]): T[] {
  const db = getVoiceDb();
  return db.prepare(sql).all(...(params || [])) as T[];
}

/** 查询单行 */
export function queryOne<T = Record<string, unknown>>(sql: string, params?: unknown[]): T | undefined {
  const db = getVoiceDb();
  return db.prepare(sql).get(...(params || [])) as T | undefined;
}

/** 执行写操作 (INSERT/UPDATE/DELETE) */
export function execute(sql: string, params?: unknown[]): Database.RunResult {
  const db = getVoiceDb();
  return db.prepare(sql).run(...(params || []));
}
