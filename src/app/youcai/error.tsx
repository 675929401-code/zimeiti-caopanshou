"use client";

interface YoucaiRouteErrorProps {
  error: Error & { digest?: string };
  reset: () => void;
  title?: string;
  message?: string;
  backHref?: string;
}

export function YoucaiRouteError({
  error,
  reset,
  title = "漫剧工作台暂时无法打开",
  message = "页面模块加载失败。你可以重新加载，或先返回工作台继续使用其他功能。",
  backHref = "/youcai",
}: YoucaiRouteErrorProps) {
  const errorReference = error.digest?.trim();

  return (
    <section
      className="grid min-h-[60vh] place-items-center bg-slate-50 px-6 text-slate-700"
      role="alert"
      aria-labelledby="youcai-route-error-title"
    >
      <div className="grid w-full max-w-lg place-items-center gap-3 rounded-2xl border border-red-200 bg-white p-8 text-center shadow-sm">
        <span className="grid h-11 w-11 place-items-center rounded-full bg-red-50 text-xl font-bold text-red-700" aria-hidden="true">
          !
        </span>
        <h1 id="youcai-route-error-title" className="text-lg font-bold text-slate-900">{title}</h1>
        <p className="text-sm leading-6 text-slate-600">{message}</p>
        {errorReference && (
          <p className="text-xs text-slate-500">错误编号：{errorReference}</p>
        )}
        <div className="mt-1 flex flex-wrap justify-center gap-3">
          <button
            className="rounded-lg bg-violet-700 px-4 py-2 text-sm font-semibold text-white hover:bg-violet-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-violet-700"
            type="button"
            onClick={reset}
          >
            重新加载
          </button>
          <a
            className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-700"
            href={backHref}
          >
            返回工作台
          </a>
        </div>
      </div>
    </section>
  );
}

export default function YoucaiError(props: YoucaiRouteErrorProps) {
  return <YoucaiRouteError {...props} />;
}
