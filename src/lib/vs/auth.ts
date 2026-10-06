import { prisma } from './prisma';
import { createHash, randomBytes, createHmac, timingSafeEqual } from 'crypto';
import bcrypt from 'bcryptjs';

const JWT_SECRET = process.env.AUTH_SECRET?.trim() ?? '';

function base64url(str: string): string {
  return Buffer.from(str).toString('base64url');
}

function base64urlDecode(str: string): string {
  return Buffer.from(str, 'base64url').toString();
}

export async function hashPassword(password: string): Promise<string> {
  // 统一用 bcrypt（与 seed.ts 一致）
  return bcrypt.hash(password, 12);
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  // 兼容两种格式：bcrypt（$2a$/$2b$开头）和旧版 sha256（salt:hash）
  if (stored.startsWith('$2a$') || stored.startsWith('$2b$') || stored.startsWith('$2y$')) {
    // bcrypt 格式
    return bcrypt.compare(password, stored);
  }
  // 旧版 sha256 格式
  const [salt, hash] = stored.split(':');
  if (!salt || !hash) return false;
  const computed = createHash('sha256').update(salt + password).digest('hex');
  try {
    return timingSafeEqual(Buffer.from(hash), Buffer.from(computed));
  } catch {
    return false;
  }
}

export function createToken(userId: string, role: string): string {
  const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = base64url(JSON.stringify({
    userId,
    role,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60,
  }));
  const signature = createHmac('sha256', JWT_SECRET).update(`${header}.${payload}`).digest('base64url');
  return `${header}.${payload}.${signature}`;
}

export function verifyToken(token: string): { userId: string; role: string } | null {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const [header, payload, signature] = parts;
    const expectedSig = createHmac('sha256', JWT_SECRET).update(`${header}.${payload}`).digest('base64url');
    if (!timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSig))) return null;
    const data = JSON.parse(base64urlDecode(payload));
    if (data.exp && data.exp < Math.floor(Date.now() / 1000)) return null;
    return { userId: data.userId, role: data.role };
  } catch { return null; }
}

export async function getUserFromRequest(request: Request): Promise<{ userId: string; role: string; email: string; name: string } | null> {
  const auth = request.headers.get('Authorization');
  if (!auth?.startsWith('Bearer ')) return null;
  const token = auth.slice(7);
  const decoded = verifyToken(token);
  if (!decoded) return null;
  const user = await prisma.user.findUnique({
    where: { id: decoded.userId },
    select: { id: true, email: true, name: true, role: true },
  });
  if (!user) return null;
  return { userId: user.id, role: user.role, email: user.email, name: user.name || '' };
}

export async function requireAdmin(request: Request): Promise<Response | null> {
  const user = await getUserFromRequest(request);
  if (!user) return Response.json({ success: false, data: null, message: '请先登录', code: 'UNAUTHORIZED' }, { status: 401 });
  if (user.role !== 'admin') return Response.json({ success: false, data: null, message: '需要管理员权限', code: 'FORBIDDEN' }, { status: 403 });
  return null;
}
