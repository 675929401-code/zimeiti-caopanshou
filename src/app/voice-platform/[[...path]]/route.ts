/**
 * 智音工坊完整版代理 — 将 /voice-platform/* 请求转发到独立 Next.js 服务（端口 5001）
 *
 * voice-platform 是一个独立的 Next.js 应用，运行在 5001 端口，
 * basePath 为 /voice-platform，所有页面和 API 路由都在此路径下。
 */

import { NextRequest, NextResponse } from 'next/server';

const VOICE_PLATFORM_PORT = process.env.VOICE_PLATFORM_PORT || '5001';
const VOICE_PLATFORM_BASE = `http://localhost:${VOICE_PLATFORM_PORT}`;

export const dynamic = 'force-dynamic';

async function proxyRequest(request: NextRequest, path: string) {
  const targetUrl = `${VOICE_PLATFORM_BASE}/voice-platform/${path}`;

  // 构建转发头
  const headers = new Headers();
  for (const [key, value] of request.headers.entries()) {
    // 跳过 hop-by-hop 头和 host
    if (['host', 'connection', 'keep-alive', 'transfer-encoding', 'upgrade'].includes(key.toLowerCase())) {
      continue;
    }
    headers.set(key, value);
  }
  headers.set('X-Forwarded-Host', request.headers.get('host') || 'localhost');
  headers.set('X-Forwarded-Proto', request.headers.get('x-forwarded-proto') || 'http');

  try {
    const method = request.method;
    const body = ['GET', 'HEAD'].includes(method) ? undefined : await request.arrayBuffer();

    const upstream = await fetch(targetUrl, {
      method,
      headers,
      body,
      // @ts-expect-error Next.js fetch 支持 duplex
      duplex: 'half',
    });

    // 复制响应头
    const responseHeaders = new Headers();
    for (const [key, value] of upstream.headers.entries()) {
      if (['transfer-encoding', 'connection', 'keep-alive'].includes(key.toLowerCase())) {
        continue;
      }
      responseHeaders.set(key, value);
    }

    // SSE 流式响应：直接透传
    if (upstream.headers.get('content-type')?.includes('text/event-stream')) {
      return new Response(upstream.body, {
        status: upstream.status,
        headers: responseHeaders,
      });
    }

    // 普通响应
    const data = await upstream.arrayBuffer();
    return new NextResponse(data, {
      status: upstream.status,
      headers: responseHeaders,
    });
  } catch (error: any) {
    console.error('[voice-platform proxy] Error:', error.message);
    return NextResponse.json(
      { error: '智音工坊服务暂时不可用', detail: error.message },
      { status: 502 }
    );
  }
}

export async function GET(request: NextRequest, { params }: { params: Promise<{ path?: string[] }> }) {
  const { path } = await params;
  return proxyRequest(request, (path || []).join('/'));
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ path?: string[] }> }) {
  const { path } = await params;
  return proxyRequest(request, (path || []).join('/'));
}

export async function PUT(request: NextRequest, { params }: { params: Promise<{ path?: string[] }> }) {
  const { path } = await params;
  return proxyRequest(request, (path || []).join('/'));
}

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ path?: string[] }> }) {
  const { path } = await params;
  return proxyRequest(request, (path || []).join('/'));
}

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ path?: string[] }> }) {
  const { path } = await params;
  return proxyRequest(request, (path || []).join('/'));
}
