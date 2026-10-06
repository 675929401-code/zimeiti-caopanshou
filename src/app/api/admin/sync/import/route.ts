// 数据导入 API - 导入 JSON + 冲突检测 + 合并策略
// 策略：以 updated_at 时间戳为准，新的覆盖旧的；本端独有的保留；对端独有的添加
import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseClient } from '@/storage/database/supabase-client';
import {
  findReservedPlatformSettingKeys,
} from '@/lib/server/platform-settings-reserved';
import { isPlatformSecretSettingKey } from '@/lib/server/platform-secret-settings';
import {
  createPlatformConfigurationCandidate,
  previewPlatformConfigurationRelease,
} from '@/lib/server/platform-configuration-admin';
import type { PlatformConfigurationKind } from '@/lib/platform-configuration-contract';

const SYNC_TABLES = ['agents', 'categories', 'platform_settings', 'announcements'];
const VERSIONED_MODEL_TABLES = ['video_models', 'cover_models', 'llm_models', 'chat_models'] as const;
const VERSIONED_WORKSPACE_SETTING_KEYS = new Set([
  'workspace_model_assignment_overrides_v1',
  'image_model_surface_orders_v1',
  'video_model_surface_orders_v1',
]);

// 表的主键字段映射
const PK_MAP: Record<string, string> = {
  agents: 'id',
  categories: 'id',
  platform_settings: 'id',
  video_models: 'id',
  cover_models: 'id',
  announcements: 'id',
};

// 需要移除的字段（数据库自动生成/不应覆盖）
const FIELDS_TO_REMOVE: Record<string, string[]> = {
  agents: [],
  categories: [],
  platform_settings: [],
  video_models: [],
  cover_models: [],
  announcements: [],
};

const SECRET_FIELDS_BY_TABLE: Record<string, string[]> = {
  agents: ['coze_coding_api_token'],
  video_models: ['api_key'],
  cover_models: ['api_key'],
};

function findImportedSecretFields(importData: Record<string, unknown>): string[] {
  const findings: string[] = [];
  for (const [tableName, fieldNames] of Object.entries(SECRET_FIELDS_BY_TABLE)) {
    const rows = importData[tableName];
    if (!Array.isArray(rows)) continue;
    for (const row of rows) {
      if (!row || typeof row !== 'object') continue;
      for (const fieldName of fieldNames) {
        if (Object.prototype.hasOwnProperty.call(row, fieldName)) {
          findings.push(`${tableName}.${fieldName}`);
        }
      }
    }
  }

  const settings = importData.platform_settings;
  if (Array.isArray(settings)) {
    for (const row of settings) {
      if (!row || typeof row !== 'object') continue;
      const settingKey = (row as Record<string, unknown>).setting_key;
      if (isPlatformSecretSettingKey(String(settingKey || ''))) {
        findings.push(`platform_settings.${String(settingKey)}`);
      }
    }
  }
  return [...new Set(findings)].slice(0, 20);
}

interface SyncResult {
  table: string;
  added: number;
  updated: number;
  skipped: number;
  errors: string[];
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

    const body = await req.json();
    const { data: importData, mode = 'merge' } = body;

    if (!importData || typeof importData !== 'object') {
      return NextResponse.json({ error: '无效的导入数据' }, { status: 400 });
    }

    // Browser-safe exports deliberately omit credentials. A destructive overwrite
    // would delete the server-side bindings and cannot reconstruct them, so this
    // endpoint only accepts non-destructive merge imports.
    if (mode === 'overwrite') {
      return NextResponse.json(
        {
          error: '安全同步只支持合并导入。全量覆盖会删除服务端密钥绑定，已阻止本次操作。',
          code: 'SAFE_MERGE_ONLY',
        },
        { status: 409 },
      );
    }
    if (mode !== 'merge') {
      return NextResponse.json({ error: 'mode 只能是 merge' }, { status: 400 });
    }

    const importedSecretFields = findImportedSecretFields(importData as Record<string, unknown>);
    if (importedSecretFields.length > 0) {
      return NextResponse.json(
        {
          error: '导入文件包含受保护密钥字段。请重新使用当前后台导出安全同步文件。',
          code: 'SYNC_SECRET_FIELDS_FORBIDDEN',
          fields: importedSecretFields,
        },
        { status: 400 },
      );
    }

    const reservedKeys = findReservedPlatformSettingKeys(
      Array.isArray(importData.platform_settings) ? importData.platform_settings : [],
    );
    if (reservedKeys.length > 0) {
      return NextResponse.json(
        {
          error: '通用同步不得创建、更新或恢复漫剧版本化配置，请使用专用控制平面',
          code: 'RESERVED_PLATFORM_SETTING_KEY',
          setting_keys: reservedKeys.slice(0, 10),
        },
        { status: 400 },
      );
    }

    const versionedWorkspaceKeys = (Array.isArray(importData.platform_settings) ? importData.platform_settings : [])
      .map((row: unknown) => row && typeof row === 'object' && !Array.isArray(row)
        ? String((row as Record<string, unknown>).setting_key || '')
        : '')
      .filter((key: string) => VERSIONED_WORKSPACE_SETTING_KEYS.has(key));
    if (versionedWorkspaceKeys.length > 0) {
      return NextResponse.json(
        {
          error: '工作台分配与排序不能通过通用同步直接覆盖；请导入完整工作台逻辑快照并确认差异预览',
          code: 'VERSIONED_WORKSPACE_SETTING_IMPORT_REQUIRED',
          setting_keys: [...new Set(versionedWorkspaceKeys)].sort(),
        },
        { status: 409 },
      );
    }

    const directModelTables = VERSIONED_MODEL_TABLES.filter((tableName) => Array.isArray(importData[tableName]));
    if (directModelTables.length > 0) {
      return NextResponse.json({
        error: '模型表不能通过通用同步直接覆盖；请导入完整逻辑快照并确认差异预览',
        code: 'VERSIONED_MODEL_TABLE_IMPORT_REQUIRED',
        tables: directModelTables,
      }, { status: 409 });
    }

    let configurationCandidate: Record<string, unknown> | null = null;
    const configurationImport = importData.platform_configuration;
    if (configurationImport !== undefined) {
      if (!configurationImport || typeof configurationImport !== 'object' || Array.isArray(configurationImport)) {
        return NextResponse.json({ error: 'platform_configuration 必须是对象', code: 'PLATFORM_CONFIGURATION_IMPORT_INVALID' }, { status: 400 });
      }
      const configuration = configurationImport as Record<string, unknown>;
      const kind = String(configuration.kind || '') as PlatformConfigurationKind;
      if (kind !== 'model-pool' && kind !== 'workspace-models') {
        return NextResponse.json({ error: 'platform_configuration.kind 无效', code: 'PLATFORM_CONFIGURATION_IMPORT_INVALID' }, { status: 400 });
      }
      const release = await createPlatformConfigurationCandidate(
        payload.userId,
        kind,
        configuration.snapshot,
        configuration.changeNote || '安全同步导入候选',
      );
      const preview = await previewPlatformConfigurationRelease(kind, String(release.id || ''));
      configurationCandidate = { kind, release, preview, published: false };
    }

    const supabase = getSupabaseClient();
    const results: SyncResult[] = [];

    for (const tableName of SYNC_TABLES) {
      const incomingRows = importData[tableName];
      if (!Array.isArray(incomingRows)) {
        results.push({ table: tableName, added: 0, updated: 0, skipped: 0, errors: ['跳过：数据格式无效'] });
        continue;
      }

      const result: SyncResult = { table: tableName, added: 0, updated: 0, skipped: 0, errors: [] };

      try {
        // 合并模式：逐条 upsert，以 updated_at 判断新旧
        // 先查本端数据
        const { data: localRows } = await supabase
          .from(tableName)
          .select('*');

        const localMap = new Map<string, Record<string, unknown>>();
        for (const row of (localRows || [])) {
          const pk = String(row[PK_MAP[tableName]]);
          localMap.set(pk, row as Record<string, unknown>);
        }

        for (const incomingRow of incomingRows) {
          const pk = String(incomingRow[PK_MAP[tableName]]);
          const localRow = localMap.get(pk);

          // 清理字段
          const cleanRow = { ...incomingRow };
          for (const f of (FIELDS_TO_REMOVE[tableName] || [])) {
            delete cleanRow[f];
          }

          if (!localRow) {
            // 本端没有，添加
            const { error } = await supabase.from(tableName).insert(cleanRow);
            if (error) {
              result.errors.push(`添加失败 (id=${pk}): ${error.message}`);
              result.skipped++;
            } else {
              result.added++;
            }
          } else {
            // 比较时间戳
            const localUpdatedAt = (localRow as Record<string, unknown>).updated_at as string | null;
            const incomingUpdatedAt = incomingRow.updated_at as string | null;

            if (incomingUpdatedAt && localUpdatedAt && incomingUpdatedAt > localUpdatedAt) {
              // 对端更新，覆盖本端
              const { error } = await supabase
                .from(tableName)
                .update(cleanRow)
                .eq(PK_MAP[tableName], pk);

              if (error) {
                result.errors.push(`更新失败 (id=${pk}): ${error.message}`);
                result.skipped++;
              } else {
                result.updated++;
              }
            } else {
              // 本端更新或相同，跳过
              result.skipped++;
            }
          }
        }
      } catch (err) {
        result.errors.push(`异常: ${err instanceof Error ? err.message : String(err)}`);
      }

      results.push(result);
    }

    return NextResponse.json({
      imported_at: new Date().toISOString(),
      mode,
      results,
      configuration_candidate: configurationCandidate,
    });
  } catch (err) {
    console.error('Import error:', err);
    return NextResponse.json(
      { error: `导入失败: ${err instanceof Error ? err.message : String(err)}` },
      { status: 500 }
    );
  }
}
