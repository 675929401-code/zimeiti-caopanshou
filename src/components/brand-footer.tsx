"use client";

import { MessageCircle } from "lucide-react";
import { usePlatformBranding } from "@/hooks/use-platform-branding";

/**
 * 统一品牌底部栏
 * - 品牌名 + 微信号 + 功能说明
 * - 所有二级页面共用
 */
export function BrandFooter({ privacyNote }: { privacyNote?: string }) {
  const branding = usePlatformBranding();
  const platformName = branding.brand.name || "自媒体操盘手";
  const platformSlogan = branding.brand.slogan || branding.brand.shortName || "AI 内容经营系统";
  const contact = branding.brand.contact || { name: "", wechat: "", phone: "", email: "" };
  const contactLine = contact.wechat
    ? `微信：${contact.wechat}`
    : contact.phone
      ? `电话：${contact.phone}`
      : contact.email
        ? `邮箱：${contact.email}`
        : platformSlogan;
  return (
    <footer
      className="mt-auto border-t"
      style={{ borderColor: "var(--border)" }}
    >
      <div className="max-w-5xl mx-auto px-4 sm:px-6 py-5">
        <div className="flex flex-col sm:flex-row items-center justify-between gap-2">
          {/* 品牌信息 */}
          <div className="flex items-center gap-3">
            <span
              className="text-sm font-bold tracking-wide"
              style={{ color: "var(--primary)" }}
            >
              {platformName}
            </span>
            <span
              className="hidden sm:inline text-xs"
              style={{ color: "var(--border)" }}
            >
              |
            </span>
            <div className="flex items-center gap-1.5">
              <MessageCircle className="w-3.5 h-3.5" style={{ color: "var(--primary)" }} />
              <span className="text-xs font-medium" style={{ color: "var(--muted-foreground)" }}>
                {contact.name ? `${contact.name} · ${contactLine}` : contactLine}
              </span>
            </div>
          </div>

          {/* 隐私说明 */}
          <div className="flex items-center gap-3">
            <span className="text-xs" style={{ color: "var(--muted-foreground)", opacity: 0.7 }}>
              {privacyNote || "具体处理与保存范围以当前功能说明为准"}
            </span>
            {/* 备案号已隐藏 */}
          </div>
        </div>
      </div>
    </footer>
  );
}
