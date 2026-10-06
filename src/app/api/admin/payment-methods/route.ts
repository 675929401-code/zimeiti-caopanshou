// 🔒 核心底层代码 — 锁定保护
//
// 本文件是管理员支付方式配置 API。
// 修改此文件需要用户明确同意，详见 AGENTS.md "🔒 锁定模块清单 #12 支付系统"。

import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdminClient } from "@/storage/database/supabase-client";
import { getTokenFromHeaders } from "@/lib/auth";
import { verifyAdminToken } from "@/lib/admin-auth";
import {
  appendAdminGovernanceAudit,
  authorizeAdminCapability,
  type AdminCapabilityResult,
} from "@/lib/server/admin-governance-authority";

type PaymentMethodMutationAuthorization = Extract<AdminCapabilityResult, { ok: true }>;

const PAYMENT_PROVIDER_CODES: Readonly<Record<string, ReadonlySet<string>>> = {
  xunhupay: new Set(["wechat", "wxpay", "alipay"]),
  epay: new Set(["wechat", "wxpay", "wechat_epay", "alipay", "alipay_epay", "qqpay"]),
};

function normalizePaymentMethodText(value: unknown, maxLength: number): string {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function validateProviderMethod(providerValue: unknown, codeValue: unknown) {
  const provider = normalizePaymentMethodText(providerValue, 32).toLowerCase();
  const code = normalizePaymentMethodText(codeValue, 64).toLowerCase();
  if (!PAYMENT_PROVIDER_CODES[provider]) {
    return { ok: false as const, error: "支付提供商仅支持迅虎支付或易支付" };
  }
  if (!PAYMENT_PROVIDER_CODES[provider].has(code)) {
    return { ok: false as const, error: "支付方式编码与所选提供商不匹配" };
  }
  return { ok: true as const, provider, code };
}

function paymentMethodValues(code: string): string[] {
  if (code === "wechat") return ["Wechat", "wechat"];
  if (code === "alipay") return ["Alipay", "alipay"];
  return [code];
}

async function authorizePaymentMethodMutation(request: NextRequest, operation: string) {
  return authorizeAdminCapability(request, "payment.settings.manage", {
    requireStepUp: true,
    operation,
    auditAllowed: true,
  });
}

async function auditPaymentMethodMutation(params: {
  request: NextRequest;
  authorization: PaymentMethodMutationAuthorization;
  action: string;
  result: "allowed" | "success" | "failure";
  reasonCode: string;
  methodId?: string | null;
  metadata?: Record<string, unknown>;
}) {
  return appendAdminGovernanceAudit({
    actorId: params.authorization.actor.userId,
    actorLevel: params.authorization.access.adminLevel,
    permissionKey: "payment.settings.manage",
    action: params.action,
    result: params.result,
    reasonCode: params.reasonCode,
    resource: params.methodId ? `payment_method:${params.methodId}` : "payment_methods",
    request: params.request,
    requestKey: (params.request.headers.get("idempotency-key") || params.request.headers.get("x-request-id") || "").slice(0, 200),
    metadata: params.metadata || {},
  });
}

function noStore(response: NextResponse): NextResponse {
  response.headers.set("Cache-Control", "private, no-store, max-age=0");
  return response;
}

// GET /api/admin/payment-methods - 管理员获取所有支付方式
export async function GET(request: NextRequest) {
  try {
    const token = getTokenFromHeaders(request.headers);
    if (!token) {
      return NextResponse.json({ error: "未登录" }, { status: 401 });
    }
    const payload = await verifyAdminToken(token);
    if (!payload?.userId || payload.role !== "admin") {
      return NextResponse.json({ error: "无权访问" }, { status: 403 });
    }

    const supabase = getSupabaseAdminClient();
    const { data, error } = await supabase
      .from("payment_methods")
      .select("id,name,code,icon,provider,is_active,sort_order,created_at,updated_at")
      .order("sort_order", { ascending: true });

    if (error) {
      console.error("获取支付方式失败:", error);
      return NextResponse.json({ error: "实时支付数据暂不可用", code: "REALTIME_DATA_UNAVAILABLE" }, { status: 503 });
    }

    // 获取各支付方式的订单统计
    const methodStats: Record<string, { total: number; success: number; totalAmount: number }> = {};
    for (const method of data || []) {
      // payment_method 字段存储 "Wechat"/"Alipay" 或小写版本，需要兼容
      const payMethodValues = method.code === "wechat"
        ? ["Wechat", "wechat"]
        : method.code === "alipay"
        ? ["Alipay", "alipay"]
        : [method.code];

      const { count: totalOrders } = await supabase
        .from("payment_orders")
        .select("id", { count: "exact", head: true })
        .in("payment_method", payMethodValues)
        .eq("payment_provider", method.provider);

      const { data: successOrders } = await supabase
        .from("payment_orders")
        .select("amount")
        .in("payment_method", payMethodValues)
        .eq("payment_provider", method.provider)
        .eq("status", "paid");

      const totalAmount = (successOrders || []).reduce((sum: number, o: { amount: number }) => sum + o.amount, 0);

      methodStats[method.id] = {
        total: totalOrders || 0,
        success: successOrders?.length || 0,
        totalAmount: Math.round(totalAmount * 100) / 100,
      };
    }

    return NextResponse.json({
      methods: data || [],
      stats: methodStats,
    });
  } catch (error) {
    console.error("管理支付方式API异常:", error);
    return NextResponse.json({ error: "服务器异常" }, { status: 500 });
  }
}

// POST /api/admin/payment-methods - 添加支付方式
export async function POST(request: NextRequest) {
  const authorization = await authorizePaymentMethodMutation(request, "payment_method_create");
  if (!authorization.ok) return noStore(authorization.response);
  try {
    const body = await request.json();
    const { name, code, icon, provider, is_active, sort_order } = body;

    const normalizedName = normalizePaymentMethodText(name, 80);
    const providerMethod = validateProviderMethod(provider || "xunhupay", code);
    if (!normalizedName || !code) {
      return NextResponse.json({ error: "名称和编码不能为空" }, { status: 400 });
    }
    if (!providerMethod.ok) return NextResponse.json({ error: providerMethod.error }, { status: 400 });

    const supabase = getSupabaseAdminClient();
    const { data: existingMethod, error: existingMethodError } = await supabase
      .from("payment_methods")
      .select("id")
      .eq("provider", providerMethod.provider)
      .eq("code", providerMethod.code)
      .limit(1)
      .maybeSingle();
    if (existingMethodError) {
      console.error("检查支付方式重复项失败:", existingMethodError);
      return NextResponse.json({ error: "支付方式校验失败" }, { status: 500 });
    }
    if (existingMethod) {
      return NextResponse.json({ error: "该支付提供商已存在相同编码" }, { status: 409 });
    }
    const normalizedIcon = normalizePaymentMethodText(icon || "wallet", 20) || "wallet";
    const normalizedSortOrder = Number(sort_order ?? 0);
    if (typeof is_active !== "undefined" && typeof is_active !== "boolean") {
      return NextResponse.json({ error: "启用状态无效" }, { status: 400 });
    }
    if (!Number.isSafeInteger(normalizedSortOrder) || normalizedSortOrder < 0 || normalizedSortOrder > 10_000) {
      return NextResponse.json({ error: "排序值无效" }, { status: 400 });
    }
    const intentRecorded = await auditPaymentMethodMutation({
      request,
      authorization,
      action: "payment_method_create_intent",
      result: "allowed",
      reasonCode: "PAYMENT_METHOD_CREATE_INTENT_RECORDED",
      metadata: {
        provider: providerMethod.provider,
        code: providerMethod.code,
        isActive: is_active !== false,
      },
    });
    if (!intentRecorded) {
      return noStore(NextResponse.json(
        { error: "支付方式审计暂不可用，本次新增未执行", code: "PAYMENT_METHOD_AUDIT_UNAVAILABLE" },
        { status: 503 },
      ));
    }
    const { data, error } = await supabase
      .from("payment_methods")
      .insert({
        name: normalizedName,
        code: providerMethod.code,
        icon: normalizedIcon,
        provider: providerMethod.provider,
        is_active: is_active !== false,
        sort_order: normalizedSortOrder,
        config: {},
      })
      .select("id,name,code,icon,provider,is_active,sort_order,created_at,updated_at")
      .single();

    if (error) {
      await auditPaymentMethodMutation({
        request,
        authorization,
        action: "payment_method_create_result",
        result: "failure",
        reasonCode: error.code === "23505" ? "PAYMENT_METHOD_DUPLICATE" : "PAYMENT_METHOD_CREATE_FAILED",
        metadata: { provider: providerMethod.provider, code: providerMethod.code },
      });
      console.error("添加支付方式失败:", error);
      if (error.code === "23505") {
        return NextResponse.json({ error: "支付方式编码已存在" }, { status: 400 });
      }
      return NextResponse.json({ error: "添加支付方式失败" }, { status: 500 });
    }

    const resultAudited = await auditPaymentMethodMutation({
      request,
      authorization,
      action: "payment_method_create_result",
      result: "success",
      reasonCode: "PAYMENT_METHOD_CREATED",
      methodId: data.id,
      metadata: { provider: data.provider, code: data.code },
    });
    return noStore(NextResponse.json({
      method: data,
      auditStatus: resultAudited ? "complete" : "authorized_intent_only",
    }, { status: resultAudited ? 201 : 202 }));
  } catch (error) {
    await auditPaymentMethodMutation({
      request,
      authorization,
      action: "payment_method_create_result",
      result: "failure",
      reasonCode: "PAYMENT_METHOD_CREATE_FAILED",
    });
    console.error("添加支付方式API异常:", error);
    return NextResponse.json({ error: "服务器异常" }, { status: 500 });
  }
}

// PUT /api/admin/payment-methods - 更新支付方式
export async function PUT(request: NextRequest) {
  const authorization = await authorizePaymentMethodMutation(request, "payment_method_update");
  if (!authorization.ok) return noStore(authorization.response);
  try {
    const body = await request.json();
    const { id, name, code, icon, provider, is_active, sort_order } = body;

    if (typeof id !== "string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu.test(id)) {
      return NextResponse.json({ error: "缺少支付方式ID" }, { status: 400 });
    }

    const supabase = getSupabaseAdminClient();
    const { data: currentMethod, error: currentMethodError } = await supabase
      .from("payment_methods")
      .select("code,provider")
      .eq("id", id)
      .maybeSingle();
    if (currentMethodError) {
      console.error("读取支付方式失败:", currentMethodError);
      return NextResponse.json({ error: "支付方式读取失败" }, { status: 500 });
    }
    if (!currentMethod) return NextResponse.json({ error: "支付方式不存在" }, { status: 404 });
    const providerMethod = validateProviderMethod(provider ?? currentMethod.provider, code ?? currentMethod.code);
    if (!providerMethod.ok) return NextResponse.json({ error: providerMethod.error }, { status: 400 });

    const { data: duplicateMethod, error: duplicateMethodError } = await supabase
      .from("payment_methods")
      .select("id")
      .eq("provider", providerMethod.provider)
      .eq("code", providerMethod.code)
      .neq("id", id)
      .limit(1)
      .maybeSingle();
    if (duplicateMethodError) {
      console.error("检查支付方式重复项失败:", duplicateMethodError);
      return NextResponse.json({ error: "支付方式校验失败" }, { status: 500 });
    }
    if (duplicateMethod) {
      return NextResponse.json({ error: "该支付提供商已存在相同编码" }, { status: 409 });
    }

    const updateData: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (name !== undefined) {
      const normalizedName = normalizePaymentMethodText(name, 80);
      if (!normalizedName) return NextResponse.json({ error: "名称不能为空" }, { status: 400 });
      updateData.name = normalizedName;
    }
    if (code !== undefined) updateData.code = providerMethod.code;
    if (icon !== undefined) {
      const normalizedIcon = normalizePaymentMethodText(icon, 20);
      if (!normalizedIcon) return NextResponse.json({ error: "图标编码无效" }, { status: 400 });
      updateData.icon = normalizedIcon;
    }
    if (provider !== undefined) updateData.provider = providerMethod.provider;
    if (is_active !== undefined) {
      if (typeof is_active !== "boolean") return NextResponse.json({ error: "启用状态无效" }, { status: 400 });
      updateData.is_active = is_active;
    }
    if (sort_order !== undefined) {
      const normalizedSortOrder = Number(sort_order);
      if (!Number.isSafeInteger(normalizedSortOrder) || normalizedSortOrder < 0 || normalizedSortOrder > 10_000) {
        return NextResponse.json({ error: "排序值无效" }, { status: 400 });
      }
      updateData.sort_order = normalizedSortOrder;
    }

    const changedFields = Object.keys(updateData).filter((key) => key !== "updated_at").sort();
    const intentRecorded = await auditPaymentMethodMutation({
      request,
      authorization,
      action: "payment_method_update_intent",
      result: "allowed",
      reasonCode: "PAYMENT_METHOD_UPDATE_INTENT_RECORDED",
      methodId: id,
      metadata: {
        changedFields,
        provider: providerMethod.provider,
        code: providerMethod.code,
      },
    });
    if (!intentRecorded) {
      return noStore(NextResponse.json(
        { error: "支付方式审计暂不可用，本次更新未执行", code: "PAYMENT_METHOD_AUDIT_UNAVAILABLE" },
        { status: 503 },
      ));
    }

    const { data, error } = await supabase
      .from("payment_methods")
      .update(updateData)
      .eq("id", id)
      .select("id,name,code,icon,provider,is_active,sort_order,created_at,updated_at")
      .single();

    if (error) {
      await auditPaymentMethodMutation({
        request,
        authorization,
        action: "payment_method_update_result",
        result: "failure",
        reasonCode: "PAYMENT_METHOD_UPDATE_FAILED",
        methodId: id,
        metadata: { changedFields },
      });
      console.error("更新支付方式失败:", error);
      return NextResponse.json({ error: "更新支付方式失败" }, { status: 500 });
    }

    const resultAudited = await auditPaymentMethodMutation({
      request,
      authorization,
      action: "payment_method_update_result",
      result: "success",
      reasonCode: "PAYMENT_METHOD_UPDATED",
      methodId: id,
      metadata: { changedFields, provider: data.provider, code: data.code },
    });
    return noStore(NextResponse.json({
      method: data,
      auditStatus: resultAudited ? "complete" : "authorized_intent_only",
    }, { status: resultAudited ? 200 : 202 }));
  } catch (error) {
    await auditPaymentMethodMutation({
      request,
      authorization,
      action: "payment_method_update_result",
      result: "failure",
      reasonCode: "PAYMENT_METHOD_UPDATE_FAILED",
    });
    console.error("更新支付方式API异常:", error);
    return NextResponse.json({ error: "服务器异常" }, { status: 500 });
  }
}

// DELETE /api/admin/payment-methods - 兼容旧客户端的停用操作；永不硬删除
export async function DELETE(request: NextRequest) {
  const authorization = await authorizePaymentMethodMutation(request, "payment_method_disable");
  if (!authorization.ok) return noStore(authorization.response);
  try {
    const { searchParams } = request.nextUrl;
    const id = searchParams.get("id");

    if (!id || !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu.test(id)) {
      return NextResponse.json({ error: "缺少支付方式ID" }, { status: 400 });
    }

    const supabase = getSupabaseAdminClient();
    const { data: currentMethod, error: currentMethodError } = await supabase
      .from("payment_methods")
      .select("id,code,provider,is_active")
      .eq("id", id)
      .maybeSingle();
    if (currentMethodError) {
      console.error("读取待停用支付方式失败:", currentMethodError);
      return NextResponse.json({ error: "支付方式读取失败" }, { status: 503 });
    }
    if (!currentMethod) return NextResponse.json({ error: "支付方式不存在" }, { status: 404 });

    const { count: referencedOrders, error: referenceError } = await supabase
      .from("payment_orders")
      .select("id", { count: "exact", head: true })
      .eq("payment_provider", currentMethod.provider)
      .in("payment_method", paymentMethodValues(currentMethod.code));
    if (referenceError) {
      console.error("检查支付方式引用失败:", referenceError);
      return NextResponse.json({ error: "无法确认支付方式引用，本次未停用" }, { status: 503 });
    }

    if (searchParams.get("hard") === "true") {
      await auditPaymentMethodMutation({
        request,
        authorization,
        action: "payment_method_hard_delete_result",
        result: "failure",
        reasonCode: (referencedOrders || 0) > 0
          ? "PAYMENT_METHOD_HARD_DELETE_REFERENCED"
          : "PAYMENT_METHOD_HARD_DELETE_DISABLED",
        methodId: id,
        metadata: { referencedOrders: referencedOrders || 0 },
      });
      return noStore(NextResponse.json(
        {
          error: (referencedOrders || 0) > 0
            ? "该支付方式已有订单引用，禁止硬删除；可停用后保留历史账务关联"
            : "支付方式硬删除已关闭；请使用停用以保留审计边界",
          code: (referencedOrders || 0) > 0
            ? "PAYMENT_METHOD_HARD_DELETE_REFERENCED"
            : "PAYMENT_METHOD_HARD_DELETE_DISABLED",
        },
        { status: 409 },
      ));
    }

    const intentRecorded = await auditPaymentMethodMutation({
      request,
      authorization,
      action: "payment_method_disable_intent",
      result: "allowed",
      reasonCode: "PAYMENT_METHOD_DISABLE_INTENT_RECORDED",
      methodId: id,
      metadata: {
        provider: currentMethod.provider,
        code: currentMethod.code,
        referencedOrders: referencedOrders || 0,
        alreadyDisabled: currentMethod.is_active !== true,
      },
    });
    if (!intentRecorded) {
      return noStore(NextResponse.json(
        { error: "支付方式审计暂不可用，本次停用未执行", code: "PAYMENT_METHOD_AUDIT_UNAVAILABLE" },
        { status: 503 },
      ));
    }

    let method = { id: currentMethod.id, is_active: false };
    if (currentMethod.is_active === true) {
      const { data, error } = await supabase
        .from("payment_methods")
        .update({ is_active: false, updated_at: new Date().toISOString() })
        .eq("id", id)
        .eq("is_active", true)
        .select("id,is_active")
        .single();
      if (error) {
        await auditPaymentMethodMutation({
          request,
          authorization,
          action: "payment_method_disable_result",
          result: "failure",
          reasonCode: "PAYMENT_METHOD_DISABLE_FAILED",
          methodId: id,
        });
        console.error("停用支付方式失败:", error);
        return NextResponse.json({ error: "停用支付方式失败" }, { status: 500 });
      }
      method = data;
    }

    const resultAudited = await auditPaymentMethodMutation({
      request,
      authorization,
      action: "payment_method_disable_result",
      result: "success",
      reasonCode: currentMethod.is_active === true ? "PAYMENT_METHOD_DISABLED" : "PAYMENT_METHOD_ALREADY_DISABLED",
      methodId: id,
      metadata: { referencedOrders: referencedOrders || 0, hardDeletePerformed: false },
    });
    return noStore(NextResponse.json({
      success: true,
      action: currentMethod.is_active === true ? "disabled" : "already_disabled",
      hardDeletePerformed: false,
      referencedOrders: referencedOrders || 0,
      method,
      auditStatus: resultAudited ? "complete" : "authorized_intent_only",
    }, { status: resultAudited ? 200 : 202 }));
  } catch (error) {
    await auditPaymentMethodMutation({
      request,
      authorization,
      action: "payment_method_disable_result",
      result: "failure",
      reasonCode: "PAYMENT_METHOD_DISABLE_FAILED",
    });
    console.error("停用支付方式API异常:", error);
    return NextResponse.json({ error: "服务器异常" }, { status: 500 });
  }
}
