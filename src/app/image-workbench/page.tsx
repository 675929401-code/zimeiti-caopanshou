import { redirect } from "next/navigation";

/**
 * “AI 生图工作台”独立板块已下线（首页“图像生成”入口同步移除）。
 * 保留旧深链：服务端跳转到首页。
 * 全站共享生图服务与封面设计、分镜编排、漫剧创作、带货创作内部的生图能力不受影响。
 */
export default function ImageWorkbenchRetiredPage() {
  redirect("/");
}
