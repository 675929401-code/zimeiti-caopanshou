interface InvitationShareTextOptions {
  code: string;
  origin: string;
}

export function buildInvitationShareText({ code, origin }: InvitationShareTextOptions) {
  const normalizedOrigin = origin.replace(/\/$/, "");
  const registrationUrl = `${normalizedOrigin}/register?invite=${encodeURIComponent(code)}`;

  return [
    "我邀请你加入自媒体操盘手",
    `注册网址：${registrationUrl}`,
    `一次性邀请码：${code}`,
    "注册说明：请使用本人QQ邮箱和手机号完成注册；本邀请码只允许一位新用户成功注册，使用后立即失效。",
    "体验说明：符合新用户资格时可获得限时体验包；体验到期后可付费升级为正式会员。",
    "安全提示：请勿转发给多人，也不要向他人提供验证码或登录密码。",
  ].join("\n");
}
