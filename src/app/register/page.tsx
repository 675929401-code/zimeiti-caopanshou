import type { Metadata } from "next";
import { AppRouteShell } from "@/components/app-route-shell";
import { PublicAuthPage } from "@/features/public-auth/public-auth-page";
import { normalizeAuthRedirect } from "@/features/public-auth/safe-auth-redirect";

export const metadata: Metadata = {
  title: "注册",
  description: "使用QQ邮箱验证码、手机号和邀请码注册自媒体操盘手账号。",
};

export default async function RegisterPage({
  searchParams,
}: {
  searchParams: Promise<{ redirect?: string | string[]; invite?: string | string[]; invitationCode?: string | string[] }>;
}) {
  const params = await searchParams;
  const redirectTo = normalizeAuthRedirect(params.redirect);
  const rawInvitationCode = Array.isArray(params.invite)
    ? params.invite[0]
    : params.invite || (Array.isArray(params.invitationCode) ? params.invitationCode[0] : params.invitationCode) || "";
  const invitationCode = /^[A-Z0-9]{8}$/u.test(String(rawInvitationCode).toUpperCase())
    ? String(rawInvitationCode).toUpperCase()
    : "";

  return (
    <AppRouteShell>
      <PublicAuthPage kind="register" redirectTo={redirectTo} invitationCode={invitationCode} />
    </AppRouteShell>
  );
}
