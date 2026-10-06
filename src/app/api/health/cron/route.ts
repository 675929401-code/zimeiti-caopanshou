import { NextRequest, NextResponse } from 'next/server';
import {
  getHealthCheckSecret,
  matchesHealthCheckSecret,
} from '@/lib/health-check-auth';

function localHealthBaseUrl(): string {
  const rawPort = process.env.DEPLOY_RUN_PORT?.trim() || '5000';
  if (!/^\d{2,5}$/u.test(rawPort)) return 'http://127.0.0.1:5000';
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return 'http://127.0.0.1:5000';
  return `http://127.0.0.1:${port}`;
}

export async function GET(request: NextRequest) {
  try {
    const configuredSecret = getHealthCheckSecret();
    if (!configuredSecret) {
      return NextResponse.json({
        error: '健康巡检尚未配置',
        code: 'HEALTH_MONITOR_NOT_CONFIGURED',
      }, { status: 503 });
    }

    // Scheduler credentials are header-only so they never enter URLs or access logs.
    if (!matchesHealthCheckSecret(request.headers.get('x-cron-secret'))) {
      return NextResponse.json({ error: '无权限', code: 'HEALTH_MONITOR_FORBIDDEN' }, { status: 403 });
    }

    const healthResponse = await fetch(`${localHealthBaseUrl()}/api/health`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Internal-Health-Check': configuredSecret,
      },
      body: JSON.stringify({ action: 'diagnose' }),
      cache: 'no-store',
    });

    if (!healthResponse.ok) {
      const errorText = await healthResponse.text();
      return NextResponse.json({ 
        error: `健康检查失败: ${errorText}`,
        timestamp: new Date().toISOString() 
      }, { status: 500 });
    }

    const result = await healthResponse.json();
    
    return NextResponse.json({
      success: true,
      timestamp: new Date().toISOString(),
      ...result,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ 
      error: `定时检查失败: ${message}`,
      timestamp: new Date().toISOString() 
    }, { status: 500 });
  }
}
