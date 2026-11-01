import {
  PUBLIC_TOKEN_BILLING_DESCRIPTION,
  type PublicTransactionBillingExplanation,
} from "@/lib/public-billing-explanation";

interface Props {
  explanation?: PublicTransactionBillingExplanation;
  metadata?: Record<string, unknown> | null;
}

function formatRate(value: number) {
  return value.toLocaleString("zh-CN", { maximumSignificantDigits: 12 });
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
      {explanation.price && <>
        <div className="grid grid-cols-3 gap-3 rounded-md border border-[var(--border)] p-2">
          {[
            ["非缓存输入", explanation.price.inputCreditsPerMillion],
            ["输出", explanation.price.outputCreditsPerMillion],
            ["缓存输入", explanation.price.cachedCreditsPerMillion],
          ].map(([label, value]) => <div key={label}>
            <p>{label}</p>
            <p className="font-medium text-[var(--foreground)]">{formatRate(Number(value))} 积分 / 百万 Token</p>
          </div>)}
        </div>
        <p>当时积分汇率：1 元 = {formatRate(explanation.price.creditsPerYuan)} 积分。{explanation.price.roundingDescription}</p>
        {explanation.baseFeeCredits != null && <p>本笔基础费用：{formatRate(explanation.baseFeeCredits)} 积分。</p>}
        <p>{PUBLIC_TOKEN_BILLING_DESCRIPTION}</p>
      </>}
      <p data-wallet-link={explanation.walletLink.status}>{explanation.walletLink.message}</p>
    </div>
  );
}
