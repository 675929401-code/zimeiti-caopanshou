"use client";

import { AlertCircle, RefreshCw } from "lucide-react";
import { useEffect } from "react";

export default function InspirationError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("youcai inspiration route error", error);
  }, [error]);

  return (
    <main className="grid min-h-[60vh] place-items-center bg-white px-6 text-slate-700">
      <section className="grid max-w-xl place-items-center gap-3 rounded-xl border border-red-200 bg-red-50 p-8 text-center" role="alert">
        <AlertCircle className="text-red-600" size={34} aria-hidden="true" />
        <h1 className="text-lg font-bold text-red-900">灵感广场暂时无法读取</h1>
        <p className="text-sm leading-6 text-red-700">素材暂时无法读取，请稍后重新加载。</p>
        <button className="inline-flex items-center gap-2 rounded-lg bg-red-700 px-4 py-2 text-sm font-semibold text-white" type="button" onClick={reset}>
          <RefreshCw size={16} aria-hidden="true" />重新加载
        </button>
      </section>
    </main>
  );
}
