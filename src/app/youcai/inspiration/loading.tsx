import { LoaderCircle } from "lucide-react";

export default function InspirationLoading() {
  return (
    <main className="grid min-h-[60vh] place-items-center bg-white px-6 text-slate-600" role="status">
      <span className="inline-flex items-center gap-2 text-sm font-semibold">
        <LoaderCircle className="animate-spin" size={20} aria-hidden="true" />
        正在读取灵感素材清单…
      </span>
    </main>
  );
}
