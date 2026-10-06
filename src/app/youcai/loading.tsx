export function YoucaiRouteLoading({ label = "正在打开漫剧工作台…" }: { label?: string }) {
  return (
    <section
      className="grid min-h-full place-items-center bg-slate-50 px-6 text-slate-700"
      role="status"
      aria-live="polite"
      aria-busy="true"
    >
      <span className="inline-flex items-center gap-3 rounded-xl border border-slate-200 bg-white px-5 py-3 text-sm font-semibold shadow-sm">
        <span
          className="h-5 w-5 animate-spin rounded-full border-2 border-slate-200 border-t-violet-600 motion-reduce:animate-none"
          aria-hidden="true"
        />
        {label}
      </span>
    </section>
  );
}

export default function YoucaiLoading() {
  return <YoucaiRouteLoading />;
}
