import { NextRequest, NextResponse } from 'next/server';

/**
 * IP 地域检测 API
 * 检查请求来源 IP 是否属于贵州省
 * 使用免费的 IP 归属地查询服务
 */

function getClientIP(request: NextRequest): string {
  const forwarded = request.headers.get('x-forwarded-for');
  const realIP = request.headers.get('x-real-ip');
  const cfIP = request.headers.get('cf-connecting-ip');
  if (cfIP) return cfIP.trim();
  if (realIP) return realIP.trim();
  if (forwarded) {
    const ips = forwarded.split(',').map(ip => ip.trim()).filter(Boolean);
    if (ips.length > 0) {
      for (let i = ips.length - 1; i >= 0; i--) {
        if (!isPrivateIP(ips[i])) return ips[i];
      }
      return ips[ips.length - 1];
    }
  }
  return 'unknown';
}

function isPrivateIP(ip: string): boolean {
  if (!ip || ip === 'unknown') return true;
  if (ip === '::1') return true;
  const parts = ip.split('.');
  if (parts.length !== 4) return false;
  const first = parseInt(parts[0], 10);
  const second = parseInt(parts[1], 10);
  if (first === 10) return true;
  if (first === 172 && second >= 16 && second <= 31) return true;
  if (first === 192 && second === 168) return true;
  if (first === 127) return true;
  return false;
}

interface IPRegionResult {
  ip: string;
  isGuizhou: boolean;
  province: string;
  city: string;
}

async function detectIPRegion(ip: string): Promise<IPRegionResult> {
  // 本地/内网 IP 直接放行
  if (!ip || ip === 'unknown' || ip === '127.0.0.1' || ip.startsWith('192.168.') || ip.startsWith('10.') || ip.startsWith('172.') || ip === '::1') {
    return { ip, isGuizhou: true, province: '本地', city: '本地' };
  }

  try {
    // 使用腾讯云 IP 归属地查询（免费，无需密钥）
    const response = await fetch(`https://whois.pconline.com.cn/ipJson.jsp?ip=${ip}&json=true`, {
      signal: AbortSignal.timeout(5000),
      headers: { 'Accept': 'application/json' },
    });

    if (response.ok) {
      const buffer = await response.arrayBuffer();
      // pconline 返回 GBK 编码，需要转换
      const decoder = new TextDecoder('gbk');
      const text = decoder.decode(buffer);
      const data = JSON.parse(text);
      const province = (data.pro || '').replace('省', '');
      const city = data.city || '';
      return {
        ip,
        isGuizhou: province === '贵州',
        province: province || '未知',
        city: city || '未知',
      };
    }
  } catch {
    // pconline 失败，尝试备用方案
  }

  try {
    // 备用：ip-api.com（免费，每分钟45次限制）
    const response = await fetch(`http://ip-api.com/json/${ip}?lang=zh-CN&fields=status,regionName,city`, {
      signal: AbortSignal.timeout(5000),
    });
    if (response.ok) {
      const data = await response.json();
      if (data.status === 'success') {
        const province = (data.regionName || '').replace('省', '');
        return {
          ip,
          isGuizhou: province === '贵州',
          province: province || '未知',
          city: data.city || '未知',
        };
      }
    }
  } catch {
    // 备用也失败
  }

  // 所有检测都失败，保守放行（避免误拦）
  return { ip, isGuizhou: true, province: '检测失败', city: '检测失败' };
}

export async function POST(request: NextRequest) {
  try {
    const clientIP = getClientIP(request);
    const result = await detectIPRegion(clientIP);

    return NextResponse.json({
      ip: result.ip,
      isGuizhou: result.isGuizhou,
      province: result.province,
      city: result.city,
      needVerification: !result.isGuizhou,
    });
  } catch {
    // 检测失败，保守放行
    return NextResponse.json({
      ip: 'unknown',
      isGuizhou: true,
      province: '检测失败',
      city: '检测失败',
      needVerification: false,
    });
  }
}

export async function GET(request: NextRequest) {
  try {
    const clientIP = getClientIP(request);
    const result = await detectIPRegion(clientIP);

    return NextResponse.json({
      ip: result.ip,
      isGuizhou: result.isGuizhou,
      province: result.province,
      city: result.city,
      needVerification: !result.isGuizhou,
    });
  } catch {
    return NextResponse.json({
      ip: 'unknown',
      isGuizhou: true,
      province: '检测失败',
      city: '检测失败',
      needVerification: false,
    });
  }
}
