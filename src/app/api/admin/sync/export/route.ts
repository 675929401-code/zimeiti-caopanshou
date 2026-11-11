// 数据导出 API - 导出全量管理数据为 JSON
import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseClient } from '@/storage/database/supabase-client';
import { MANJU_PLATFORM_SETTINGS_PREFIX, isReservedPlatformSettingKey } from '@/lib/server/platform-settings-reserved';
import { isPlatformSecretSettingKey } from '@/lib/server/platform-secret-settings';

// 需要同步的管理配置表
const SYNC_TABLES = [
  { name: 'agents', orderBy: 'updated_at' },
  { name: 'categories', orderBy: 'sort_order' },
  { name: 'platform_settings', orderBy: 'id' },
  { name: 'video_models', orderBy: 'id' },
  { name: 'cover_models', orderBy: 'id' },
  { name: 'announcements', orderBy: 'created_at' },
];

function isSensitiveSettingKey(key: unknown): boolean {
  const normalized = String(key || '');
  return isPlatformSecretSettingKey(normalized)
    || /(?:token|secret|password|passphrase|api[_-]?key|access[_-]?key|private[_-]?key)/iu.test(normalized);
}

function sanitizeExportRows(tableName: string, rows: Record<string, unknown>[]): Record<string, unknown>[] {
  if (tableName === 'platform_settings') {
    return rows.filter((row) => !isSensitiveSettingKey(row.setting_key) && !isReservedPlatformSettingKey(row.setting_key));
  }
  return rows.map((row) => {
    const safe = { ...row };
    if (tableName === 'agents') delete safe.coze_coding_api_token;
    if (tableName === 'video_models' || tableName === 'cover_models') delete safe.api_key;
    return safe;
  });
}

export async function POST(req: NextRequest) {
  try {
    // 验证管理员权限
    const authHeader = req.headers.get('authorization');
    if (!authHeader?.startsWith('Bearer ')) {
      return NextResponse.json({ error: '未授权' }, { status: 401 });
    }

    const token = authHeader.slice(7);
    const { verifyAdminToken } = await import('@/lib/admin-auth');
    const payload = await verifyAdminToken(token);
    if (!payload || payload.role !== 'admin') {
      return NextResponse.json({ error: '需要管理员权限' }, { status: 403 });
    }

    const supabase = getSupabaseClient();
    const exportData: Record<string, unknown[]> = {};
    const errors: string[] = [];

    for (const table of SYNC_TABLES) {
      let query = supabase
        .from(table.name)
        .select('*');
      if (table.name === 'platform_settings') {
        query = query.not('setting_key', 'like', `${MANJU_PLATFORM_SETTINGS_PREFIX}%`);
      }
      const { data, error } = await query;

      if (error) {
        errors.push(`${table.name}: ${error.message}`);
        exportData[table.name] = [];
      } else {
        exportData[table.name] = sanitizeExportRows(
          table.name,
          (data || []) as Record<string, unknown>[],
        );
      }
    }

    return NextResponse.json({
      version: 1,
      exported_at: new Date().toISOString(),
      source: process.env.COZE_PROJECT_ENV === 'PROD' ? 'production' : 'sandbox',
      tables: SYNC_TABLES.map(t => t.name),
      excluded_namespaces: [MANJU_PLATFORM_SETTINGS_PREFIX],
      reserved_settings_excluded: true,
      secret_fields_excluded: true,
      credential_binding_required_on_import: true,
      data: exportData,
      ...(errors.length > 0 ? { errors } : {}),
    });
  } catch (err) {
    console.error('Export error:', err);
    return NextResponse.json(
      { error: `导出失败: ${err instanceof Error ? err.message : String(err)}` },
      { status: 500 }
    );
  }
}
