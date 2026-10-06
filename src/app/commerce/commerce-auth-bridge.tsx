"use client";

/*
 * 带货Agent 鉴权桥（第二阶段扣费前置）：
 * 进入 /commerce 时，用主站登录态换取带货会话（cookie）。
 * 管理员 → 绑定本机工作室身份（继承历史数据）；
 * 学生 → 绑定专属身份；两种角色的生成动作都按模型价格扣主站钱包。
 * 绑定一次，cookie 7 天有效；过期后本组件随布局挂载自动重绑。
 */
import { useEffect } from "react";

const MAIN_TOKEN_KEY = "auth_token";
export const COMMERCE_SESSION_READY_EVENT = "commerce-session-ready";

export function CommerceAuthBridge() {
  useEffect(() => {
    let active = true;
    let running = false;
    const connect = async () => {
      if (running) return;
      const mainToken = (() => {
        try { return localStorage.getItem(MAIN_TOKEN_KEY)?.trim() || ""; } catch { return ""; }
      })();
      if (!mainToken) return;
      running = true;
      try {
        const current = await fetch("/api/commerce/session", {
          cache: "no-store",
          headers: { Authorization: `Bearer ${mainToken}` },
        });
        if (current.ok) {
          if (active) window.dispatchEvent(new Event(COMMERCE_SESSION_READY_EVENT));
          return;
        }
        const r = await fetch("/api/commerce/session", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "main-bind", mainToken }),
        });
        if (r.ok && active) window.dispatchEvent(new Event(COMMERCE_SESSION_READY_EVENT));
      } catch { /* 保持当前编辑状态，定时或重新聚焦后继续连接。 */ }
      finally { running = false; }
    };
    const retry = () => { if (document.visibilityState !== "hidden") void connect(); };
    void connect();
    const timer = window.setInterval(retry, 10_000);
    window.addEventListener("focus", retry);
    document.addEventListener("visibilitychange", retry);
    return () => {
      active = false;
      window.clearInterval(timer);
      window.removeEventListener("focus", retry);
      document.removeEventListener("visibilitychange", retry);
    };
  }, []);
  return null;
}
