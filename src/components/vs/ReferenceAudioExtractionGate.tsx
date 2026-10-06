'use client';

import { AlertCircle, BadgeCheck, RefreshCw } from 'lucide-react';
import { useToolRuntimeCatalog, type ToolRuntimeQuote } from '@/hooks/use-tool-runtime-catalog';

export function referenceAudioPriceLabel(quote?: ToolRuntimeQuote) {
  if (!quote) return '价格未就绪';
  if (quote.unitPrice === 0) return '免费';
  if (quote.unitPrice === null) return '按实际用量结算';
  const amount = quote.unitPrice.toLocaleString('zh-CN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 4,
    useGrouping: false,
  });
  return `¥${amount}/${quote.unit}`;
}

export function useReferenceAudioRuntimeGate(token: string) {
  const catalog = useToolRuntimeCatalog(token);
  const quote = catalog.items.video;
  const ready = Boolean(token && !catalog.loading && !catalog.error && quote?.available);
  return {
    ...catalog,
    quote,
    ready,
    priceLabel: referenceAudioPriceLabel(quote),
  };
}

export function ReferenceAudioRuntimeStatus({
  gate,
}: {
  gate: ReturnType<typeof useReferenceAudioRuntimeGate>;
}) {
  if (gate.loading) {
    return (
      <p role="status" data-testid="reference-audio-runtime-status" className="flex items-center gap-2 rounded-xl border border-[var(--vs-border)] bg-[var(--vs-control-bg)] px-3 py-2 text-sm text-[var(--vs-text-secondary)]">
        <RefreshCw className="h-4 w-4 animate-spin" aria-hidden="true" />
        正在核对视频解析通道与公开价格…
      </p>
    );
  }
  if (!gate.ready) {
    return (
      <div role="alert" data-testid="reference-audio-runtime-status" className="flex items-center justify-between gap-3 rounded-xl border border-[var(--vs-border)] bg-[var(--vs-control-bg)] px-3 py-2 text-sm text-[var(--vs-text-secondary)]">
        <span className="flex min-w-0 items-center gap-2">
          <AlertCircle className="h-4 w-4 shrink-0 text-[var(--error)]" aria-hidden="true" />
          {gate.error || (gate.quote ? '视频解析通道当前不可用，链接提取已暂停。' : '价格尚未就绪，链接提取已暂停。')}
        </span>
        <button type="button" onClick={() => void gate.refresh()} className="shrink-0 rounded-lg border border-[var(--vs-border)] px-2.5 py-1.5 font-semibold text-[var(--vs-text)] hover:border-[var(--vs-primary)]">
          重新读取
        </button>
      </div>
    );
  }
  return (
    <p role="status" data-testid="reference-audio-runtime-status" className="flex items-center gap-2 rounded-xl border border-[var(--vs-border)] bg-[var(--vs-control-bg)] px-3 py-2 text-sm text-[var(--vs-text-secondary)]">
      <BadgeCheck className="h-4 w-4 shrink-0 text-[var(--vs-primary)]" aria-hidden="true" />
      视频解析通道已就绪 · 本次公开价格 <strong className="text-[var(--vs-text)]">{gate.priceLabel}</strong>
    </p>
  );
}

export function ReferenceAudioChargeConfirm({
  open,
  priceLabel,
  busy,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  priceLabel: string;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/55 px-6 backdrop-blur-sm" role="presentation" onMouseDown={(event) => { if (event.currentTarget === event.target && !busy) onCancel(); }}>
      <section role="dialog" aria-modal="true" aria-labelledby="reference-audio-charge-title" data-testid="reference-audio-charge-confirm" className="w-full max-w-md rounded-2xl border border-[var(--vs-border)] bg-[var(--vs-surface)] p-6 text-[var(--vs-text)] shadow-2xl">
        <h3 id="reference-audio-charge-title" className="text-lg font-bold">确认链接提取费用</h3>
        <p className="mt-3 text-sm leading-6 text-[var(--vs-text-secondary)]">
          本次会按视频解析通道公开价格 <strong className="text-[var(--vs-text)]">{priceLabel}</strong> 创建一次请求。解析成功后再从签名临时视频中提取参考音频；取消不会提交请求或产生扣费。
        </p>
        <div className="mt-5 flex justify-end gap-2">
          <button type="button" disabled={busy} onClick={onCancel} className="rounded-xl border border-[var(--vs-border)] px-4 py-2 text-sm font-semibold text-[var(--vs-text-secondary)] hover:text-[var(--vs-text)] disabled:opacity-50">
            取消
          </button>
          <button type="button" disabled={busy} onClick={onConfirm} className="rounded-xl border border-[var(--vs-primary)] bg-[var(--vs-primary)] px-4 py-2 text-sm font-semibold text-[var(--vs-on-accent)] hover:opacity-90 disabled:opacity-50">
            {busy ? '正在提取…' : `确认并支付 ${priceLabel}`}
          </button>
        </div>
      </section>
    </div>
  );
}
