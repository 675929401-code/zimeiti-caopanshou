import type { Metadata } from "next";
import { AppRouteShell } from "@/components/app-route-shell";
import { PublicAuthPage } from "@/features/public-auth/public-auth-page";

export const metadata: Metadata = {
  title: "找回密码",
  description: "通过注册邮箱验证登录后，在个人中心设置新密码。",
};

export default function ForgotPasswordPage() {
  return (
    <AppRouteShell>
      <PublicAuthPage kind="recover" redirectTo="/profile?tab=password" />
    </AppRouteShell>
  );
}
