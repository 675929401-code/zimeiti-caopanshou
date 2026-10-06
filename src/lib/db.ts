// Database utility - unified Supabase cloud database
// All data operations go through Supabase (single source of truth)
// PG Pool is kept ONLY for sql-exec.ts legacy queries (invitation_codes, notifications, etc.)
// New code MUST use getSupabaseClient().from(table) instead of from()/getPool()

import { Pool, PoolConfig, types } from 'pg';

// 修复 pg 库将 UUID 类型(OID 2950)返回为 Buffer 的问题
// 统一将 UUID 解析为字符串，避免前端/后端出现 [56 27 206 61 ...] 的 Buffer 字符串
types.setTypeParser(2950, (val: string) => val);

let pool: Pool | null = null;

function getPoolConfig(): PoolConfig {
  // PGDATABASE_URL 已废弃 — 不再使用平台内部PG库
  // 仅当显式配置 PG 连接参数时才走 PG（用于 sql-exec.ts 遗留功能）
  const connectionString = process.env.PGDATABASE_URL || process.env.DATABASE_URL || '';
  if (connectionString && connectionString.length > 0) {
    const sslRequired = connectionString.includes('sslmode=require') || connectionString.includes('sslmode=verify');
    return { connectionString, max: 10, idleTimeoutMillis: 30000, connectionTimeoutMillis: 5000, ssl: sslRequired ? { rejectUnauthorized: false } : false };
  }
  return {
    host: process.env.PG_HOST || '127.0.0.1',
    port: parseInt(process.env.PG_PORT || '5432'),
    database: process.env.PG_DATABASE || 'agent_hub',
    user: process.env.PG_USER || 'agenthub',
    password: process.env.PG_PASSWORD?.trim() ?? '',
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
    ssl: false,
  };
}

export function getPool(): Pool {
  if (!pool) {
    pool = new Pool(getPoolConfig());
    pool.on('error', (err) => {
      console.error('Unexpected PG pool error:', err);
    });
  }
  return pool;
}

// ============================================================
// Supabase-compatible query builder (for standalone PG deployments)
// ============================================================

type QueryMethod = 'select' | 'insert' | 'update' | 'delete' | 'upsert';

class QueryBuilder {
  private table: string;
  private method: QueryMethod = 'select';
  private selectCols: string = '*';
  private filters: Array<{ col: string; op: string; val: unknown }> = [];
  private orderCol?: string;
  private orderDir: 'ASC' | 'DESC' = 'ASC';
  private limitVal?: number;
  private offsetVal?: number;
  private insertData?: Record<string, unknown> | Record<string, unknown>[];
  private updateData?: Record<string, unknown>;
  private onConflictCols?: string[];
  private isSingle = false;
  private inFilters: Array<{ col: string; vals: unknown[] }> = [];
  private notFilters: Array<{ col: string; op: string; val: unknown }> = [];
  private isFilter?: { col: string; val: unknown };
  private orConditions: string[] = [];

  constructor(table: string) {
    this.table = table;
  }

  select(cols: string = '*') {
    this.method = 'select';
    this.selectCols = cols;
    return this;
  }

  insert(data: Record<string, unknown> | Record<string, unknown>[]) {
    this.method = 'insert';
    this.insertData = data;
    return this;
  }

  update(data: Record<string, unknown>) {
    this.method = 'update';
    this.updateData = data;
    return this;
  }

  delete() {
    this.method = 'delete';
    return this;
  }

  upsert(data: Record<string, unknown> | Record<string, unknown>[], opts?: { onConflict?: string }) {
    this.method = 'upsert';
    this.insertData = data;
    if (opts?.onConflict) {
      this.onConflictCols = opts.onConflict.split(',').map(s => s.trim());
    }
    return this;
  }

  eq(col: string, val: unknown) {
    this.filters.push({ col, op: '=', val });
    return this;
  }

  neq(col: string, val: unknown) {
    this.filters.push({ col, op: '!=', val });
    return this;
  }

  gt(col: string, val: unknown) {
    this.filters.push({ col, op: '>', val });
    return this;
  }

  gte(col: string, val: unknown) {
    this.filters.push({ col, op: '>=', val });
    return this;
  }

  lt(col: string, val: unknown) {
    this.filters.push({ col, op: '<', val });
    return this;
  }

  lte(col: string, val: unknown) {
    this.filters.push({ col, op: '<=', val });
    return this;
  }

  like(col: string, val: string) {
    this.filters.push({ col, op: 'LIKE', val });
    return this;
  }

  ilike(col: string, val: string) {
    this.filters.push({ col, op: 'ILIKE', val });
    return this;
  }

  in(col: string, vals: unknown[]) {
    this.inFilters.push({ col, vals });
    return this;
  }

  is(col: string, val: unknown) {
    this.isFilter = { col, val };
    return this;
  }

  not(col: string, op: string, val: unknown) {
    this.notFilters.push({ col, op, val });
    return this;
  }

  or(conditions: string) {
    this.orConditions = conditions.split(',').map(c => c.trim());
    return this;
  }

  order(col: string, opts?: { ascending?: boolean }) {
    this.orderCol = col;
    this.orderDir = opts?.ascending === false ? 'DESC' : 'ASC';
    return this;
  }

  limit(n: number) {
    this.limitVal = n;
    return this;
  }

  offset(n: number) {
    this.offsetVal = n;
    return this;
  }

  range(from: number, to: number) {
    this.limitVal = to - from + 1;
    this.offsetVal = from;
    return this;
  }

  single() {
    this.isSingle = true;
    return this;
  }

  maybeSingle() {
    this.isSingle = true;
    return this;
  }

  private buildWhere(params: unknown[]): string {
    const conditions: string[] = [];
    let idx = params.length + 1;

    for (const f of this.filters) {
      if (f.val === null || f.val === undefined) {
        if (f.op === '=' || f.op === 'IS') {
          conditions.push(`${f.col} IS NULL`);
        } else if (f.op === '!=') {
          conditions.push(`${f.col} IS NOT NULL`);
        } else {
          conditions.push(`${f.col} ${f.op} $${idx}`);
          params.push(f.val);
          idx++;
        }
      } else {
        conditions.push(`${f.col} ${f.op} $${idx}`);
        params.push(f.val);
        idx++;
      }
    }

    for (const f of this.inFilters) {
      const ph: string[] = [];
      for (const v of f.vals) {
        ph.push(`$${idx}`);
        params.push(v);
        idx++;
      }
      conditions.push(`${f.col} IN (${ph.join(', ')})`);
    }

    for (const f of this.notFilters) {
      if (f.val === null || f.val === undefined) {
        if (f.op === '=' || f.op === 'IS') {
          conditions.push(`${f.col} IS NOT NULL`);
        } else {
          conditions.push(`NOT (${f.col} ${f.op} $${idx})`);
          params.push(f.val);
          idx++;
        }
      } else {
        conditions.push(`NOT (${f.col} ${f.op} $${idx})`);
        params.push(f.val);
        idx++;
      }
    }

    if (this.isFilter) {
      if (this.isFilter.val === null) {
        conditions.push(`${this.isFilter.col} IS NULL`);
      } else {
        conditions.push(`${this.isFilter.col} IS NOT NULL`);
      }
    }

    if (this.orConditions.length > 0) {
      const orParts: string[] = [];
      for (const cond of this.orConditions) {
        const match = cond.match(/^(\w+)\.(\w+)\.(.+)$/);
        if (match) {
          const [, col, opStr, val] = match;
          const opMap: Record<string, string> = { eq: '=', neq: '!=', gt: '>', gte: '>=', lt: '<', lte: '<=', like: 'LIKE', ilike: 'ILIKE' };
          const sqlOp = opMap[opStr] || '=';
          conditions.push(`${col} ${sqlOp} $${idx}`);
          params.push(val);
          idx++;
          orParts.push(conditions.pop()!);
        }
      }
      if (orParts.length > 0) {
        conditions.push(`(${orParts.join(' OR ')})`);
      }
    }

    return conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';
  }

  async then(resolve: (result: { data: unknown; error: unknown }) => void, reject?: (error: unknown) => void) {
    try {
      const result = await this.execute();
      resolve(result);
    } catch (err) {
      reject?.(err);
    }
  }

  async execute(): Promise<{ data: unknown; error: unknown }> {
    const pool = getPool();
    const params: unknown[] = [];

    try {
      if (this.method === 'select') {
        let sql = `SELECT ${this.selectCols} FROM ${this.table}`;
        const where = this.buildWhere(params);
        if (where) sql += ` ${where}`;
        if (this.orderCol) sql += ` ORDER BY ${this.orderCol} ${this.orderDir}`;
        if (this.limitVal) sql += ` LIMIT ${this.limitVal}`;
        if (this.offsetVal) sql += ` OFFSET ${this.offsetVal}`;

        const result = await pool.query(sql, params);

        if (this.isSingle) {
          if (result.rows.length === 0) {
            return { data: null, error: null };
          }
          return { data: result.rows[0], error: null };
        }
        return { data: result.rows, error: null };
      }

      if (this.method === 'insert') {
        const data = Array.isArray(this.insertData) ? this.insertData : [this.insertData!];
        const allCols = [...new Set(data.flatMap(Object.keys))];
        const allRows: string[] = [];
        let idx = 1;

        for (const row of data) {
          const vals = allCols.map(c => (c in row ? row[c] : null));
          const ph = vals.map(() => `$${idx++}`);
          params.push(...vals);
          allRows.push(`(${ph.join(', ')})`);
        }

        let sql = `INSERT INTO ${this.table} (${allCols.join(', ')}) VALUES ${allRows.join(', ')}`;

        if (this.onConflictCols && this.onConflictCols.length > 0) {
          const updateSet = allCols
            .filter(c => !this.onConflictCols!.includes(c))
            .map(c => `${c} = EXCLUDED.${c}`);
          sql += ` ON CONFLICT (${this.onConflictCols.join(', ')}) DO UPDATE SET ${updateSet.join(', ')}`;
        }
        sql += ' RETURNING *';

        const result = await pool.query(sql, params);
        if (data.length === 1) {
          return { data: result.rows[0] || data[0], error: null };
        }
        return { data: result.rows.length > 0 ? result.rows : data, error: null };
      }

      if (this.method === 'upsert') {
        const data = Array.isArray(this.insertData) ? this.insertData[0] : this.insertData!;
        const cols = Object.keys(data);
        const vals = Object.values(data);
        const placeholders = vals.map((_, i) => `$${i + 1}`);
        params.push(...vals);

        const conflictCols = this.onConflictCols || [cols[0]];
        const updateSet = cols
          .filter(c => !conflictCols.includes(c))
          .map(c => `${c} = EXCLUDED.${c}`);

        let sql = `INSERT INTO ${this.table} (${cols.join(', ')}) VALUES (${placeholders.join(', ')})`;
        sql += ` ON CONFLICT (${conflictCols.join(', ')}) DO UPDATE SET ${updateSet.join(', ')}`;
        sql += ` RETURNING *`;

        const result = await pool.query(sql, params);
        return { data: result.rows[0] || data, error: null };
      }

      if (this.method === 'update') {
        if (!this.updateData) return { data: null, error: 'No update data' };
        const setClauses: string[] = [];
        let idx = 1;
        for (const [key, val] of Object.entries(this.updateData)) {
          setClauses.push(`${key} = $${idx}`);
          params.push(val);
          idx++;
        }
        let sql = `UPDATE ${this.table} SET ${setClauses.join(', ')}`;
        const where = this.buildWhere(params);
        if (where) sql += ` ${where}`;
        const result = await pool.query(sql + ' RETURNING *', params);
        if (this.isSingle && result.rows.length > 0) {
          return { data: result.rows[0], error: null };
        }
        return { data: result.rows, error: null };
      }

      if (this.method === 'delete') {
        let sql = `DELETE FROM ${this.table}`;
        const where = this.buildWhere(params);
        if (where) sql += ` ${where}`;
        const result = await pool.query(sql + ' RETURNING *', params);
        return { data: result.rows, error: null };
      }

      return { data: null, error: 'Unknown method' };
    } catch (err) {
      console.error('DB query error:', err);
      return { data: null, error: err instanceof Error ? err.message : String(err) };
    }
  }
}

// ============================================================
// Unified getDb() - always goes through Supabase cloud
// ============================================================

export function from(table: string): QueryBuilder {
  return new QueryBuilder(table);
}

export function getDb() {
  const { getSupabaseClient } = require("../storage/database/supabase-client");
  return getSupabaseClient();
}

export function isSupabaseAvailable(): boolean {
  return !!(process.env.COZE_SUPABASE_URL && (process.env.COZE_SUPABASE_ANON_KEY || process.env.COZE_SUPABASE_SERVICE_ROLE_KEY));
}
