import type { Metadata } from "next";
import { AdminLoginPage } from "@/components/admin/admin-login-page";
import { safeAdminRedirect } from "@/lib/admin-entry";

export const metadata: Metadata = {
  title: "管理员登录",
  description: "自媒体操盘手后台管理员登录入口。",
  robots: { index: false, follow: false, noarchive: true, nosnippet: true, noimageindex: true },
};

export default async function AdminLoginRoute({
  searchParams,
}: {
  searchParams: Promise<{ redirect?: string | string[] }>;
}) {
  const params = await searchParams;
  return <AdminLoginPage redirectTo={safeAdminRedirect(params.redirect)} />;
}
