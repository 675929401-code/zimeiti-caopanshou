import { redirect } from 'next/navigation';

/*
 * 带货Agent 入口（第一阶段共宿主后：主站内直达 /commerce）。
 * 回滚通道：显式设置 COMMERCE_AGENT_URL 时仍跳转独立 5048 应用。
 */
export default function CommerceAgentEntry() {
  const fallback = process.env.COMMERCE_AGENT_URL?.trim();
  if (fallback) {
    const url = new URL(fallback);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Invalid commerce application URL');
    redirect(url.href);
  }
  redirect('/commerce');
}
