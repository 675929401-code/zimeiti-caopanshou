import { normalizeDisplayText } from '@/lib/display-normalization';

function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
    .replace(/"/gu, '&quot;')
    .replace(/'/gu, '&#39;');
}

export type VerificationEmailPurpose =
  | '登录验证'
  | '注册账号'
  | '绑定安全邮箱'
  | '更换安全手机'
  | '修改登录密码'
  | '创建学员账号'
  | '重置学员密码'
  | '管理员安全验证'
  | '身份验证';

export function buildVerificationEmail(
  platformNameValue: string,
  codeValue: string,
  purposeValue: VerificationEmailPurpose = '身份验证',
) {
  const platformName = normalizeDisplayText(platformNameValue, '智能体操盘手').slice(0, 64);
  const purpose = normalizeDisplayText(purposeValue, '身份验证').slice(0, 32);
  const code = String(codeValue || '').replace(/\s+/gu, '').slice(0, 12);
  const safePlatformName = escapeHtml(platformName);
  const safePurpose = escapeHtml(purpose);
  const safeCode = escapeHtml(code);
  const subject = `【${platformName}】${purpose}验证码`;
  const text = [
    `${platformName} · ${purpose}`,
    '',
    `您的验证码：${code}`,
    '有效时间：5 分钟',
    '',
    '请只在您本人正在操作的页面中输入此验证码，不要转发或告知他人。',
    '如非本人操作，请忽略此邮件；平台工作人员不会向您索要验证码。',
    '',
    `此邮件由 ${platformName} 系统自动发送，请勿直接回复。`,
  ].join('\n');
  const html = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="color-scheme" content="light only">
  <title>${safePurpose}验证码</title>
</head>
<body style="margin:0;padding:0;background-color:#eef4f7;color:#102a33;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC','Hiragino Sans GB','Microsoft YaHei',Arial,sans-serif;">
  <span style="display:none!important;visibility:hidden;opacity:0;color:transparent;height:0;width:0;overflow:hidden;">${safePlatformName} ${safePurpose}验证码，5 分钟内有效。</span>
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" bgcolor="#eef4f7" style="width:100%;background-color:#eef4f7;">
    <tr>
      <td align="center" style="padding:36px 20px;">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" bgcolor="#ffffff" style="width:100%;max-width:560px;background-color:#ffffff;border:1px solid #d8e4e8;border-radius:20px;box-shadow:0 16px 40px rgba(15,61,70,0.10);overflow:hidden;">
          <tr><td style="height:6px;background-color:#0f766e;font-size:0;line-height:0;">&nbsp;</td></tr>
          <tr>
            <td style="padding:30px 34px 8px;">
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
                <tr>
                  <td>
                    <div style="font-size:11px;line-height:18px;font-weight:700;letter-spacing:2px;color:#0f766e;text-transform:uppercase;">SECURITY VERIFICATION</div>
                    <div style="margin-top:7px;font-size:22px;line-height:32px;font-weight:800;color:#102a33;">${safePlatformName}</div>
                  </td>
                  <td align="right" valign="middle"><span style="display:inline-block;padding:7px 11px;border:1px solid #b9ddd8;border-radius:999px;background-color:#edf9f7;font-size:12px;line-height:16px;font-weight:700;color:#0f766e;">${safePurpose}</span></td>
                </tr>
              </table>
            </td>
          </tr>
          <tr>
            <td style="padding:18px 34px 0;">
              <div style="font-size:16px;line-height:26px;font-weight:700;color:#183b45;">您好，请完成本次安全验证</div>
              <div style="margin-top:6px;font-size:14px;line-height:23px;color:#607780;">请在正在操作的页面中输入下方验证码。为保护账号安全，请勿向任何人透露。</div>
            </td>
          </tr>
          <tr>
            <td style="padding:22px 34px 0;">
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" bgcolor="#f3faf9" style="width:100%;background-color:#f3faf9;border:1px solid #c8e5e1;border-radius:16px;">
                <tr>
                  <td align="center" style="padding:24px 20px 22px;">
                    <div style="font-size:12px;line-height:18px;font-weight:700;letter-spacing:1px;color:#6b8189;">您的验证码</div>
                    <div style="margin-top:8px;font-family:Consolas,'Courier New',monospace;font-size:38px;line-height:48px;font-weight:800;letter-spacing:9px;color:#0f766e;">${safeCode}</div>
                    <div style="margin-top:7px;font-size:13px;line-height:20px;color:#6b8189;">5 分钟内有效 · 仅可使用一次</div>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          <tr>
            <td style="padding:20px 34px 30px;">
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" bgcolor="#fff9eb" style="width:100%;background-color:#fff9eb;border:1px solid #f3ddb0;border-radius:12px;">
                <tr><td style="padding:14px 16px;font-size:12px;line-height:20px;color:#765b20;"><strong style="color:#5f4717;">安全提醒</strong><br>如非本人操作，请直接忽略此邮件。平台工作人员不会通过电话、聊天或私信向您索要验证码。</td></tr>
              </table>
              <div style="margin-top:20px;padding-top:18px;border-top:1px solid #e5edef;font-size:12px;line-height:20px;color:#87979d;text-align:center;">此邮件由 ${safePlatformName} 系统自动发送，请勿直接回复。</div>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
  return { subject, text, html };
}
