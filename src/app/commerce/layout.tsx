import type { Metadata } from 'next';
import './commerce-globals.css';
import { CommerceAuthBridge } from './commerce-auth-bridge';

/*
 * 带货Agent 嵌套布局（第一阶段：同进程共宿主）
 * 不渲染 html/body —— 根布局归主站；本层只引入 commerce 专属样式作用域与元数据。
 * .commerce-root 由各页面自身的根容器渲染（workspace/settings 等）。
 * CommerceAuthBridge：主站登录态 → 带货身份绑定（第二阶段扣费的鉴权前置）。
 */
export const metadata: Metadata = { title: '带货 Agent · 创作工作台', description: '主站统一的 AI 商业内容创作工作台' };

export default function CommerceLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <CommerceAuthBridge />
      {children}
    </>
  );
}
