import type { Metadata } from "next";
import { AppRouteShell } from "@/components/app-route-shell";
import { PublicAuthPage } from "@/features/public-auth/public-auth-page";
import { normalizeAuthRedirect } from "@/features/public-auth/safe-auth-redirect";

export const metadata: Metadata = {
  title: "登录",
  description: "登录自媒体操盘手并安全返回原创作页面。",
};

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ redirect?: string | string[] }>;
}) {
  const params = await searchParams;
  const redirectTo = normalizeAuthRedirect(params.redirect);

  return (
    <AppRouteShell>
      <PublicAuthPage kind="login" redirectTo={redirectTo} />
    </AppRouteShell>
  );
}
