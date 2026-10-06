import { ArrowLeft, BookOpen, ShieldCheck } from "lucide-react";
import { AppScopedLink } from "@/components/app-scoped-link";

export function FormalScriptUnavailable({ brandLabel }: { brandLabel: string }) {
  return (
    <section
      className="relative grid min-h-[calc(100vh-48px)] place-items-center overflow-hidden bg-background px-5 py-12 text-foreground"
      data-testid="formal-script-unavailable"
      aria-labelledby="formal-script-unavailable-title"
    >
      <div
        className="pointer-events-none absolute inset-0 opacity-70"
        aria-hidden="true"
        style={{
          background:
            "radial-gradient(circle at 20% 20%, color-mix(in srgb, var(--primary) 18%, transparent), transparent 34%), radial-gradient(circle at 80% 76%, color-mix(in srgb, #69e7ff 14%, transparent), transparent 30%)",
        }}
      />
      <div className="relative w-full max-w-3xl rounded-3xl border border-border bg-card/90 p-7 shadow-2xl backdrop-blur-xl sm:p-10">
        <span className="inline-flex items-center gap-2 rounded-full border border-amber-400/30 bg-amber-400/10 px-3 py-1.5 text-sm font-semibold text-amber-600 dark:text-amber-300">
          <BookOpen size={16} aria-hidden="true" />
          暂不可用
        </span>
        <h1 id="formal-script-unavailable-title" className="mt-5 text-3xl font-bold tracking-tight sm:text-4xl">
          正剧专用工作流正在升级
        </h1>
        <p className="mt-4 text-base leading-8 text-muted-foreground">
          当前可以先使用影视工坊整理剧本、角色和分镜。正剧专用创作能力恢复后会在这里直接开放。
        </p>
        <div className="mt-6 flex gap-3 rounded-2xl border border-border bg-muted/40 p-4 text-sm leading-6 text-muted-foreground">
          <ShieldCheck className="mt-0.5 shrink-0 text-primary" size={19} aria-hidden="true" />
          <p>
            升级期间本页不会提交生成请求，也不会产生费用。
          </p>
        </div>
        <div className="mt-8 flex flex-wrap items-center justify-between gap-4">
          <AppScopedLink
            className="inline-flex min-h-11 items-center gap-2 rounded-xl bg-primary px-5 font-semibold text-primary-foreground transition-opacity hover:opacity-90"
            href="/tools/film-studio"
          >
            <ArrowLeft size={16} aria-hidden="true" />
            返回{brandLabel}
          </AppScopedLink>
          <span className="text-xs text-muted-foreground">当前状态：仅信息页，无生成动作</span>
        </div>
      </div>
    </section>
  );
}
