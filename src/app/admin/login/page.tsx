import { redirect } from "next/navigation";
import { ADMIN_LOGIN_PATH } from "@/lib/admin-entry";

export default async function LegacyAdminLoginRoute({
  searchParams,
}: {
  searchParams: Promise<{ redirect?: string | string[] }>;
}) {
  const params = await searchParams;
  const candidate = Array.isArray(params.redirect) ? params.redirect[0] : params.redirect;
  const query = candidate ? `?redirect=${encodeURIComponent(candidate)}` : "";
  redirect(`${ADMIN_LOGIN_PATH}${query}`);
}
