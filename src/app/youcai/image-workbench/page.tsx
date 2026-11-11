import { redirect } from "next/navigation";

/** 原 youcai 图片工作台别名页随 AI 生图工作台一同下线，重定向直接落到首页。 */
export default function YoucaiImageWorkbenchRetiredPage() {
  redirect("/");
}
