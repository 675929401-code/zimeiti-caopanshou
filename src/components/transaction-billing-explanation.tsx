import {
  type PublicTransactionBillingExplanation,
} from "@/lib/public-billing-explanation";

interface Props {
  explanation?: PublicTransactionBillingExplanation;
  metadata?: Record<string, unknown> | null;
}

export function TransactionBillingExplanation({ explanation, metadata }: Props) {
  if (!explanation) return null;
  const usage = [
    ["输入（含缓存）", metadata?.prompt_tokens],
    ["输出", metadata?.completion_tokens],
    ["缓存命中", metadata?.cached_tokens],
  ] as const;
  return (
    <div data-billing-explanation={explanation.status} className="mt-2 space-y-2 border-t border-[var(--border)] pt-2 text-xs leading-relaxed text-[var(--muted-foreground)]">
      <div className="flex flex-wrap gap-x-4 gap-y-1">
        {typeof metadata?.agent_name === "string" && <span>智能体：{metadata.agent_name}</span>}
        {typeof metadata?.public_model_id === "string" && <span className="break-all">公开模型：{metadata.public_model_id}</span>}
        {usage.map(([label, value]) => typeof value === "number" && <span key={label}>{label} {value.toLocaleString("zh-CN")} Token</span>)}
      </div>
      <p>{explanation.message}</p>
      <p data-wallet-link={explanation.walletLink.status}>{explanation.walletLink.message}</p>
    </div>
  );
}
