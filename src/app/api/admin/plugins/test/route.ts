import { getSupabaseClient } from "@/storage/database/supabase-client";
import { NextRequest, NextResponse } from "next/server";
import { verifyAdminToken } from "@/lib/admin-auth";

// 插件连接测试 API — 测试各类插件的连通性

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

export async function POST(request: NextRequest) {
  const userId = await requireAdmin(request);
  if (!userId) {
    return NextResponse.json({ error: "未授权" }, { status: 401 });
  }

  try {
    const body = await request.json();
    const { type, config } = body;

    if (!type || !config) {
      return NextResponse.json({ error: "缺少插件类型或配置" }, { status: 400 });
    }

    switch (type) {
      case "coze":
        return await testCozePlugin(config);
      case "third_party":
        return await testThirdPartyPlugin(config);
      case "page_embed":
        return await testPageEmbedPlugin(config);
      default:
        return NextResponse.json({ error: "未知的插件类型" }, { status: 400 });
    }
  } catch (err) {
    console.error("[Plugin Test] Error:", err);
    return NextResponse.json({ error: "测试失败", detail: String(err) }, { status: 500 });
  }
}

// ============ 扣子插件测试 ============

/**
 * 扣子插件有两种接入方式：
 * 1. Coze 托管工作流 URL（如 https://xxx.coze.site/run 或 /stream_run）
 *    - 直接用 Bearer Token 调用工作流，测试方式：发一个轻量请求看是否可达
 * 2. Coze OpenAPI（如 https://api.coze.cn）
 *    - 使用 PAT 或 OAuth Token，测试方式：调用 /v1/bots 或 /v1/workflows 接口
 */
async function testCozePlugin(config: Record<string, unknown>) {
  const apiBase = (config.api_base_url as string || "").trim();
  const apiToken = (config.api_token as string || "").trim();
  const subtype = config.subtype as string || "workflow";

  if (!apiBase && !apiToken) {
    return NextResponse.json({ connected: false, error: "未填写 API 地址和 Token" });
  }
  if (!apiBase) {
    return NextResponse.json({ connected: false, error: "未填写 API 地址" });
  }
  if (!apiToken) {
    return NextResponse.json({ connected: false, error: "未填写 API Token" });
  }

  // 判断是否为 Coze 托管工作流 URL（包含 .coze.site 或 /run、/stream_run 路径）
  const isCozeSite = apiBase.includes(".coze.site") || apiBase.includes("/run") || apiBase.includes("/stream_run");

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);

    if (isCozeSite) {
      // 方式一：测试 Coze 托管工作流连通性
      // 构造一个最小化的 POST 请求（不带实际参数），期望返回 4xx 参数错误而非 401/403
      const testUrl = apiBase.replace(/\/run$/, "/run").replace(/\/stream_run$/, "/stream_run");
      const res = await fetch(testUrl, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${apiToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({}), // 空请求体，仅测试连通性
        signal: controller.signal,
      });

      clearTimeout(timeout);

      // 工作流返回 400/422 说明 Token 有效但参数不全 = 连接成功
      // 返回 200 也是成功
      // 返回 401/403 说明认证失败
      if (res.ok) {
        return NextResponse.json({
          connected: true,
          message: "工作流连接成功，Token 有效",
          details: { apiBase, mode: "coze_site_workflow" },
        });
      } else if (res.status === 400 || res.status === 422) {
        // 参数错误说明认证通过了，只是请求体不完整
        return NextResponse.json({
          connected: true,
          message: "连接成功（Token 有效，服务可达）",
          details: { apiBase, mode: "coze_site_workflow", statusCode: res.status },
        });
      } else if (res.status === 401 || res.status === 403) {
        const errorText = await res.text().catch(() => "");
        return NextResponse.json({
          connected: false,
          error: `认证失败 (HTTP ${res.status})：Token 无效或权限不足`,
          details: { apiBase, statusCode: res.status, response: errorText.substring(0, 200) },
        });
      } else {
        const errorText = await res.text().catch(() => "");
        return NextResponse.json({
          connected: false,
          error: `HTTP ${res.status}: ${errorText.substring(0, 200)}`,
        });
      }
    } else {
      // 方式二：测试 Coze OpenAPI（api.coze.cn 或 api.coze.com）
      const baseUrl = apiBase.replace(/\/$/, "");
      let testEndpoint: string;
      if (subtype === "bot") {
        testEndpoint = `${baseUrl}/v1/bots?page_size=1`;
      } else if (subtype === "workflow") {
        testEndpoint = `${baseUrl}/v1/workflows?page_size=1`;
      } else {
        testEndpoint = `${baseUrl}/v1/bots?page_size=1`;
      }

      const res = await fetch(testEndpoint, {
        headers: {
          "Authorization": `Bearer ${apiToken}`,
          "Content-Type": "application/json",
        },
        signal: controller.signal,
      });

      clearTimeout(timeout);

      if (res.ok) {
        const data = await res.json().catch(() => ({}));
        const count = data.data?.length ?? 0;
        const label = subtype === "workflow" ? "工作流" : "智能体";
        return NextResponse.json({
          connected: true,
          message: `连接成功，发现 ${count} 个${label}`,
          details: { apiBase, mode: "coze_openapi", count },
        });
      } else if (res.status === 401 || res.status === 403) {
        return NextResponse.json({
          connected: false,
          error: `认证失败 (HTTP ${res.status})：Token 无效或权限不足`,
        });
      } else {
        const errorText = await res.text().catch(() => "");
        return NextResponse.json({
          connected: false,
          error: `HTTP ${res.status}: ${errorText.substring(0, 200)}`,
        });
      }
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({
      connected: false,
      error: message.includes("abort") ? "连接超时(15秒)" : message,
    });
  }
}

// ============ 第三方API插件测试 ============

async function testThirdPartyPlugin(config: Record<string, unknown>) {
  const apiBase = config.api_base_url as string || "";
  const apiKey = config.api_key as string || "";
  const authType = config.auth_type as string || "bearer";
  const testPath = config.test_path as string || "/";
  const customHeaders = config.custom_headers as Record<string, string> || {};

  if (!apiBase) {
    return NextResponse.json({ connected: false, error: "未填写 API 地址" });
  }

  try {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...customHeaders,
    };

    // 根据认证类型设置 Authorization 头
    if (apiKey) {
      switch (authType) {
        case "bearer":
          headers["Authorization"] = `Bearer ${apiKey}`;
          break;
        case "basic":
          headers["Authorization"] = `Basic ${Buffer.from(apiKey).toString("base64")}`;
          break;
        case "api_key_header": {
          const headerName = config.auth_header_name as string || "X-API-Key";
          headers[headerName] = apiKey;
          break;
        }
        case "query_param": {
          const paramName = config.auth_param_name as string || "api_key";
          const separator = testPath.includes("?") ? "&" : "?";
          const url = new URL(apiBase + testPath);
          url.searchParams.set(paramName, apiKey);
          break;
        }
        // custom 类型已由 custom_headers 处理
      }
    }

    const testUrl = apiBase + testPath;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);

    const res = await fetch(testUrl, {
      method: "GET",
      headers,
      signal: controller.signal,
    });

    clearTimeout(timeout);

    // 即使返回非 200 也视为"可达"，因为有些 API 的测试路径需要 POST
    if (res.status < 500) {
      return NextResponse.json({
        connected: true,
        message: `服务可达 (HTTP ${res.status})`,
        details: { apiBase, statusCode: res.status },
      });
    } else {
      return NextResponse.json({
        connected: false,
        error: `服务端错误 (HTTP ${res.status})`,
      });
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({
      connected: false,
      error: message.includes("abort") ? "连接超时(10秒)" : message,
    });
  }
}

// ============ 页面嵌入插件测试 ============

async function testPageEmbedPlugin(config: Record<string, unknown>) {
  const embedUrl = config.embed_url as string || "";

  if (!embedUrl) {
    return NextResponse.json({ connected: false, error: "未填写嵌入地址" });
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);

    const res = await fetch(embedUrl, {
      method: "HEAD",
      signal: controller.signal,
    });

    clearTimeout(timeout);

    const contentType = res.headers.get("content-type") || "";
    return NextResponse.json({
      connected: true,
      message: `页面可达 (HTTP ${res.status})`,
      details: {
        url: embedUrl,
        statusCode: res.status,
        contentType,
        isHtml: contentType.includes("text/html"),
      },
    });
  } catch (err: unknown) {
    // 嵌入页面即使 HEAD 失败也可能 iframe 可用
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({
      connected: false,
      error: `无法访问: ${message.includes("abort") ? "连接超时(10秒)" : message}`,
      note: "部分页面禁止 HEAD 请求，但 iframe 嵌入可能仍可正常使用",
    });
  }
}
