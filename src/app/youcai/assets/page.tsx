import type { Metadata } from "next";
import { AppRouteShell } from "@/components/app-route-shell";
import { OfficialAssetsRoute } from "@/features/official-core-routes/official-assets-route";

export const metadata: Metadata = {
  title: "个人资产",
  description: "在漫剧工作台内统一查看账户已落库的生成记录与上传素材。",
};

export default function AssetsPage() {
  return (
    <AppRouteShell>
      <OfficialAssetsRoute />
    </AppRouteShell>
  );
}
