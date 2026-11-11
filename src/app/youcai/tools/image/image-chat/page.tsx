import { redirect } from "next/navigation";

/** 原 youcai“图片创作（对话式）”别名页随 AI 生图工作台一同下线，保留旧深链跳转。 */
export default function YoucaiImageChatRetiredPage() {
  redirect("/");
}
