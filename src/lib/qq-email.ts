const QQ_EMAIL_PATTERN = /^[1-9]\d{4,11}@qq\.com$/iu;

export function normalizeQqEmail(value: unknown): string {
  return String(value ?? "").trim().toLowerCase();
}

export function isQqEmail(value: unknown): boolean {
  return QQ_EMAIL_PATTERN.test(normalizeQqEmail(value));
}

export function qqEmailError(value: unknown): string | null {
  if (!normalizeQqEmail(value)) return "QQ邮箱为必填项";
  return isQqEmail(value) ? null : "请输入QQ邮箱（例如 123456789@qq.com）";
}

