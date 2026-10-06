import { getSupabaseClient } from "@/storage/database/supabase-client";
import { NextRequest, NextResponse } from "next/server";
import { verifyAdminToken } from "@/lib/admin-auth";
import { normalizeDisplayText } from "@/lib/display-normalization";
import {
  clearPluginConfigSecrets,
  mergePluginConfigSecrets,
  sanitizePluginForAdmin,
  validatePluginMetadataInput,
} from "@/lib/plugin-metadata";

// 插件管理 API — 支持 CRUD + 角色切换 + 测试连接

// ============ 类型定义 ============

interface PluginRecord {
  id: string;
  name: string;
  type: "coze" | "third_party" | "page_embed" | "knowledge_base" | "workflow";
  subtype: string;
  role: string;
  description: string;
  icon: string;
  is_active: boolean;
  config: Record<string, unknown>;
  price_per_use: number;
  cost_price: number;
  price_unit: string;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

// 系统功能角色定义
const SYSTEM_ROLES: Record<string, { label: string; type: "coze" | "third_party"; subtype: string; desc: string }> = {
  extract_workflow: {
    label: "文案提取",
    type: "coze",
    subtype: "workflow",
    desc: "提取抖音/小红书/快手等平台的视频口播文案",
  },
  extract_text_third_party: {
    label: "文案提取(第三方差价)",
    type: "third_party",
    subtype: "text_extract",
    desc: "第三方去水印接口快速提取视频描述文案（低成本渠道，适合标题+描述提取）",
  },
  extract_batch_third_party: {
    label: "批量文案提取(第三方)",
    type: "third_party",
    subtype: "batch_text_extract",
    desc: "批量提取博主主页视频文案，支持按点赞数筛选和数量限制",
  },
  coze_multifunction_extract: {
    label: "三合一提取插件",
    type: "coze",
    subtype: "multifunction_extract",
    desc: "视频下载、单条文案、博主批量与关键词搜索共用的三合一提取插件；四项能力使用同一配置和价格",
  },
  cover_workflow: {
    label: "封面生成",
    type: "coze",
    subtype: "workflow",
    desc: "AI 自动生成智能体封面图",
  },
};

// ============ 鉴权工具 ============

async function requireAdmin(request: NextRequest): Promise<string | null> {
  const authHeader = request.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) return null;
  const token = authHeader.slice(7);
  try {
    const payload = await verifyAdminToken(token);
    if (payload && payload.role === "admin") return payload.userId;
    return null;
  } catch {
    return null;
  }
}

// ============ GET: 获取插件列表 ============

export async function GET(request: NextRequest) {
  const userId = await requireAdmin(request);
  if (!userId) {
    return NextResponse.json({ error: "未授权" }, { status: 401 });
  }

  try {
    const client = getSupabaseClient();
    const { searchParams } = new URL(request.url);
    const type = searchParams.get("type");
    const role = searchParams.get("role");
    const id = searchParams.get("id");

    // 详情与列表使用相同掩码；保存时由服务端保留未修改的凭据。
    if (id) {
      const { data, error } = await client
        .from("plugins")
        .select("*")
        .eq("id", id)
        .single();

      if (error) {
        console.error("[Plugins] Fetch single error:", error);
        return NextResponse.json({ error: "获取插件详情失败" }, { status: 500 });
      }

      if (!data) {
        return NextResponse.json({ error: "插件不存在" }, { status: 404 });
      }

      return NextResponse.json({ plugin: sanitizePluginForAdmin(data) });
    }

    // 列表模式：脱敏返回
    let query = client
      .from("plugins")
      .select("*")
      .order("sort_order", { ascending: true })
      .order("created_at", { ascending: false });

    if (type) {
      query = query.eq("type", type);
    }
    if (role) {
      const roles = role.split(",");
      if (roles.length === 1) {
        query = query.eq("role", role);
      } else {
        query = query.in("role", roles);
      }
    }

    const { data, error } = await query;

    if (error) {
      console.error("[Plugins] Fetch error:", error);
      return NextResponse.json({ error: "获取插件列表失败" }, { status: 500 });
    }

    // 脱敏：不在列表中返回完整的密钥，只返回掩码
    const sanitized = (data || []).map((p: PluginRecord) => sanitizePluginForAdmin(p));

    // 同时返回系统角色定义，供前端使用
    return NextResponse.json({ plugins: sanitized, systemRoles: SYSTEM_ROLES });
  } catch (err) {
    console.error("[Plugins] GET error:", err);
    return NextResponse.json({ error: "服务器错误" }, { status: 500 });
  }
}

// ============ POST: 创建插件 ============

export async function POST(request: NextRequest) {
  const userId = await requireAdmin(request);
  if (!userId) {
    return NextResponse.json({ error: "未授权" }, { status: 401 });
  }

  try {
    const body = await request.json();
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return NextResponse.json({ error: "请求必须为 JSON 对象" }, { status: 400 });
    }
    const { name, type, subtype, role, description, icon, config, is_active, sort_order, price_per_use, cost_price, price_unit } = body;

    const metadataError = validatePluginMetadataInput(body, true);
    if (metadataError) {
      return NextResponse.json({ error: metadataError }, { status: 400 });
    }
    if (role === "extract_video") {
      return NextResponse.json({
        error: "旧视频提取角色仅保留历史数据兼容，请使用三合一提取插件",
      }, { status: 400 });
    }

    // 校验 config 字段
    const configValidation = validateConfig(type, config || {});
    if (!configValidation.valid) {
      return NextResponse.json({ error: configValidation.message }, { status: 400 });
    }

    const client = getSupabaseClient();

    // 如果有 role 且 is_active=true，先停用同 role 的其他插件。
    // 三合一插件与两种旧单条文案角色互斥，确保新请求只有一个事实源。
    // 旧批量角色仍可读取，但新运行目录只认三合一插件。
    if (role && is_active !== false) {
      const SINGLE_TEXT_EXTRACT_ROLES = ["extract_workflow", "extract_text_third_party", "coze_multifunction_extract"];
      const rolesToDeactivate = SINGLE_TEXT_EXTRACT_ROLES.includes(role) ? SINGLE_TEXT_EXTRACT_ROLES : [role];
      await client
        .from("plugins")
        .update({ is_active: false, updated_at: new Date().toISOString() })
        .in("role", rolesToDeactivate)
        .eq("is_active", true);
    }

    const { data, error } = await client
      .from("plugins")
      .insert({
        name: normalizeDisplayText(name),
        type,
        subtype: subtype || getDefaultSubtype(type),
        role: role || "",
        description: normalizeDisplayText(description),
        icon: icon || getDefaultIcon(type),
        is_active: is_active !== undefined ? is_active : true,
        config: normalizeConfigLabels(mergePluginConfigSecrets(config, {})),
        price_per_use: price_per_use === undefined ? 0 : Number(price_per_use),
        cost_price: cost_price === undefined ? 0 : Number(cost_price),
        price_unit: normalizeDisplayText(price_unit, "次"),
        sort_order: sort_order || 0,
      })
      .select()
      .single();

    if (error) {
      console.error("[Plugins] Create error:", error);
      return NextResponse.json({ error: "创建插件失败" }, { status: 500 });
    }

    return NextResponse.json({ plugin: sanitizePluginForAdmin(data) }, { status: 201 });
  } catch (err) {
    console.error("[Plugins] POST error:", err);
    return NextResponse.json({ error: "服务器错误" }, { status: 500 });
  }
}

// ============ PUT: 更新插件 ============

export async function PUT(request: NextRequest) {
  const userId = await requireAdmin(request);
  if (!userId) {
    return NextResponse.json({ error: "未授权" }, { status: 401 });
  }

  try {
    const body = await request.json();
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return NextResponse.json({ error: "请求必须为 JSON 对象" }, { status: 400 });
    }
    const { id, name, type, subtype, role, description, icon, config, is_active, sort_order, price_per_use, cost_price, price_unit } = body;

    if (!id) {
      return NextResponse.json({ error: "插件ID为必填项" }, { status: 400 });
    }

    const metadataError = validatePluginMetadataInput(body);
    if (metadataError) {
      return NextResponse.json({ error: metadataError }, { status: 400 });
    }

    const client = getSupabaseClient();
    const { data: existing, error: existingError } = await client
      .from("plugins")
      .select("id, type, config, role, is_active")
      .eq("id", id)
      .maybeSingle();
    if (existingError) {
      return NextResponse.json({ error: "读取原插件配置失败，未保存任何修改" }, { status: 500 });
    }
    if (!existing) {
      return NextResponse.json({ error: "插件不存在" }, { status: 404 });
    }
    const targetsLegacyVideoRole = role === "extract_video"
      || (role === undefined && existing.role === "extract_video");
    if ((role === "extract_video" && existing.role !== "extract_video")
      || (targetsLegacyVideoRole && is_active === true)) {
      return NextResponse.json({
        error: "旧视频提取角色仅保留历史数据兼容，不能再作为新视频通道启用",
      }, { status: 400 });
    }
    let finalConfig = config === undefined
      ? existing.config
      : normalizeConfigLabels(mergePluginConfigSecrets(config, existing.config));
    try {
      finalConfig = clearPluginConfigSecrets(finalConfig, existing.config, body.clear_secret_fields);
    } catch {
      return NextResponse.json({ error: "只能显式清除已配置的凭据字段" }, { status: 400 });
    }
    if (config !== undefined || type !== undefined) {
      const configValidation = validateConfig(type ?? existing.type, finalConfig);
      if (!configValidation.valid) {
        return NextResponse.json({ error: configValidation.message }, { status: 400 });
      }
    }

    // 如果只更新部分字段（如 is_active），仅更新传入的字段
    const updateFields: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (name !== undefined) updateFields.name = normalizeDisplayText(name);
    if (type !== undefined) updateFields.type = type;
    if (subtype !== undefined) updateFields.subtype = subtype;
    if (role !== undefined) updateFields.role = role;
    if (description !== undefined) updateFields.description = normalizeDisplayText(description);
    if (icon !== undefined) updateFields.icon = icon;
    if (config !== undefined || body.clear_secret_fields !== undefined) updateFields.config = finalConfig;
    if (is_active !== undefined) updateFields.is_active = is_active;
    if (sort_order !== undefined) updateFields.sort_order = sort_order;
    if (price_per_use !== undefined) updateFields.price_per_use = Number(price_per_use);
    if (cost_price !== undefined) updateFields.cost_price = Number(cost_price);
    if (price_unit !== undefined) updateFields.price_unit = normalizeDisplayText(price_unit, "次");

    // ★ 核心：激活时自动停用同 role 的其他插件
    // 如果前端没传 role，从数据库查当前插件的 role
    const effectiveRole = role ?? existing.role ?? "";

    // 提取插件互斥规则：
    // - 三合一插件与两种旧单条文案角色互斥，避免新请求读取到多个候选。
    // - extract_batch_third_party 作为历史批量角色保持独立，但不再进入三合一运行目录。
    // ★ 触发条件：is_active=true（显式激活）或 编辑带role的插件时当前已是激活状态
    const shouldDeactivateSiblings = is_active === true
      || (is_active === undefined && existing.is_active === true && role !== undefined && effectiveRole);
    if (shouldDeactivateSiblings && effectiveRole) {
      const SINGLE_TEXT_EXTRACT_ROLES = ["extract_workflow", "extract_text_third_party", "coze_multifunction_extract"];
      const rolesToDeactivate = SINGLE_TEXT_EXTRACT_ROLES.includes(effectiveRole) ? SINGLE_TEXT_EXTRACT_ROLES : [effectiveRole];
      await client
        .from("plugins")
        .update({ is_active: false, updated_at: new Date().toISOString() })
        .in("role", rolesToDeactivate)
        .eq("is_active", true)
        .neq("id", id);
    }

    const { data, error } = await client
      .from("plugins")
      .update(updateFields)
      .eq("id", id)
      .select()
      .single();

    if (error) {
      console.error("[Plugins] Update error:", error);
      return NextResponse.json({ error: "更新插件失败" }, { status: 500 });
    }

    if (!data) {
      return NextResponse.json({ error: "插件不存在" }, { status: 404 });
    }

    return NextResponse.json({ plugin: sanitizePluginForAdmin(data) });
  } catch (err) {
    console.error("[Plugins] PUT error:", err);
    return NextResponse.json({ error: "服务器错误" }, { status: 500 });
  }
}

// ============ DELETE: 删除插件 ============

export async function DELETE(request: NextRequest) {
  const userId = await requireAdmin(request);
  if (!userId) {
    return NextResponse.json({ error: "未授权" }, { status: 401 });
  }

  try {
    const { searchParams } = new URL(request.url);
    const id = searchParams.get("id");

    if (!id) {
      return NextResponse.json({ error: "插件ID为必填项" }, { status: 400 });
    }

    const client = getSupabaseClient();
    const { error } = await client.from("plugins").delete().eq("id", id);

    if (error) {
      console.error("[Plugins] Delete error:", error);
      return NextResponse.json({ error: "删除插件失败" }, { status: 500 });
    }

    return NextResponse.json({ success: true });
  } catch (err) {
    console.error("[Plugins] DELETE error:", err);
    return NextResponse.json({ error: "服务器错误" }, { status: 500 });
  }
}

// ============ 配置校验 ============

function validateConfig(type: string, config: Record<string, unknown>): { valid: boolean; message?: string } {
  if (!config || typeof config !== "object") {
    return { valid: false, message: "配置必须为JSON对象" };
  }

  switch (type) {
    case "coze": {
      if (!config.api_base_url) {
        return { valid: false, message: "扣子插件必须填写 API 地址" };
      }
      if (!isValidHttpsApiBaseUrl(config.api_base_url)) {
        return { valid: false, message: "扣子插件 API 地址必须是有效的 HTTPS 地址" };
      }
      return { valid: true };
    }
    case "third_party": {
      if (!config.api_base_url) {
        return { valid: false, message: "第三方API插件必须填写 API 地址" };
      }
      if (!isValidHttpsApiBaseUrl(config.api_base_url)) {
        return { valid: false, message: "第三方 API 地址必须是有效的 HTTPS 地址" };
      }
      return { valid: true };
    }
    case "page_embed": {
      if (!config.embed_url) {
        return { valid: false, message: "页面嵌入插件必须填写嵌入地址" };
      }
      return { valid: true };
    }
    default:
      return { valid: true };
  }
}

function isValidHttpsApiBaseUrl(value: unknown): boolean {
  if (typeof value !== "string" || !value.trim()) return false;
  try {
    const url = new URL(value.trim());
    return url.protocol === "https:"
      && Boolean(url.hostname)
      && !url.username
      && !url.password;
  } catch {
    return false;
  }
}

// ============ 工具函数 ============

function getDefaultSubtype(type: string): string {
  switch (type) {
    case "coze": return "workflow";
    case "workflow": return "workflow";
    case "third_party": return "video_gen";
    case "page_embed": return "iframe";
    case "knowledge_base": return "coze";
    default: return "";
  }
}

function getDefaultIcon(type: string): string {
  switch (type) {
    case "coze": return "🔌";
    case "workflow": return "🔌";
    case "third_party": return "🔗";
    case "page_embed": return "📄";
    case "knowledge_base": return "📚";
    default: return "📦";
  }
}

function normalizeConfigLabels(config: Record<string, unknown>): Record<string, unknown> {
  return {
    ...config,
    ...(typeof config.site_name === "string" ? { site_name: normalizeDisplayText(config.site_name) } : {}),
  };
}
