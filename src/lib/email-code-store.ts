// 邮箱验证码内存存储
interface CodeEntry {
  code: string;
  expiresAt: number;
  attempts: number; // 验证尝试次数
}

// Next 会把不同 API Route 编译为不同模块。将短期验证码状态挂到同一 Node
// 进程的 globalThis，避免“发送接口存入一份 Map、验证接口读取另一份 Map”。
// 多进程/重启场景仍应在部署时使用共享验证码存储，本实现至少保证单 Web 进程闭环。
const verificationState = globalThis as typeof globalThis & {
  __emailVerificationCodes?: Map<string, CodeEntry>;
  __emailVerificationCooldowns?: Map<string, number>;
  __emailVerificationCleanupStarted?: boolean;
};

// purpose + email -> CodeEntry。不同操作的验证码不可交叉复用。
const codeStore = verificationState.__emailVerificationCodes ??= new Map<string, CodeEntry>();

// 同一邮箱、同一用途 60 秒内只能发送一次。
const sendCooldown = verificationState.__emailVerificationCooldowns ??= new Map<string, number>();

const CODE_EXPIRY = 5 * 60 * 1000; // 5分钟
const CODE_LENGTH = 6;
const MAX_ATTEMPTS = 5; // 最多验证5次
const SEND_COOLDOWN = 60 * 1000; // 60秒冷却

export function generateCode(): string {
  let code = '';
  for (let i = 0; i < CODE_LENGTH; i++) {
    code += Math.floor(Math.random() * 10).toString();
  }
  return code;
}

function storeKey(email: string, purpose: string): string {
  return `${purpose.trim().toLowerCase() || "login"}:${email.trim().toLowerCase()}`;
}

export function storeCode(email: string, code: string, purpose = "login"): { ok: boolean; error?: string } {
  const now = Date.now();
  const key = storeKey(email, purpose);

  // 检查发送冷却
  const lastSend = sendCooldown.get(key);
  if (lastSend && now - lastSend < SEND_COOLDOWN) {
    const remaining = Math.ceil((SEND_COOLDOWN - (now - lastSend)) / 1000);
    return { ok: false, error: `请${remaining}秒后再试` };
  }

  codeStore.set(key, {
    code,
    expiresAt: now + CODE_EXPIRY,
    attempts: 0,
  });
  sendCooldown.set(key, now);

  return { ok: true };
}

export function verifyCode(email: string, inputCode: string, purpose = "login"): { ok: boolean; error?: string } {
  const key = storeKey(email, purpose);
  const entry = codeStore.get(key);

  if (!entry) {
    return { ok: false, error: '验证码已过期，请重新获取' };
  }

  const now = Date.now();

  if (now > entry.expiresAt) {
    codeStore.delete(key);
    return { ok: false, error: '验证码已过期，请重新获取' };
  }

  if (entry.attempts >= MAX_ATTEMPTS) {
    codeStore.delete(key);
    return { ok: false, error: '验证码错误次数过多，请重新获取' };
  }

  entry.attempts++;

  if (entry.code !== inputCode) {
    return { ok: false, error: '验证码错误' };
  }

  // 验证成功，删除验证码
  codeStore.delete(key);
  sendCooldown.delete(key);

  return { ok: true };
}

// 定期清理过期验证码（每5分钟）
if (typeof setInterval !== 'undefined' && !verificationState.__emailVerificationCleanupStarted) {
  verificationState.__emailVerificationCleanupStarted = true;
  const cleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const [email, entry] of codeStore) {
      if (now > entry.expiresAt) {
        codeStore.delete(email);
      }
    }
    for (const [email, lastSend] of sendCooldown) {
      if (now - lastSend > SEND_COOLDOWN) {
        sendCooldown.delete(email);
      }
    }
  }, 5 * 60 * 1000);
  cleanupTimer.unref?.();
}
