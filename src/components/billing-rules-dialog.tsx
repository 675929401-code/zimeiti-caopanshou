"use client";

import { useState, useEffect } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Coins, Info, ArrowRight, Zap, Database, Clock } from "lucide-react";

interface BillingRulesDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

interface BillingRulesData {
  creditsPerYuan: number;
  tokenRoundingUnit: number;
  inputCreditsPer1k: number;
  outputCreditsPer1k: number;
  cachedCreditsPer1k: number;
  tokensPerCreditInput: number;
  tokensPerCreditOutput: number;
  tokensPerCreditCached: number;
  tokensPer100Input: number;
  tokensPer100Output: number;
  roundingDescription: string;
  rechargeExamples: Array<{
    yuan: number;
    credits: number;
    approxInputTokens: number;
    approxOutputTokens: number;
  }>;
}

export function BillingRulesDialog({ open, onOpenChange }: BillingRulesDialogProps) {
  const [rules, setRules] = useState<BillingRulesData | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (open && !rules) {
      setLoading(true);
      fetch("/api/credits/rules")
        .then((res) => res.json())
        .then((data) => setRules(data))
        .catch((e: unknown) => { console.error("[billing-rules-dialog] fetchRules failed:", e instanceof Error ? e.message : e); })
        .finally(() => setLoading(false));
    }
  }, [open, rules]);

  const fmtNum = (n: number) => n.toLocaleString();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[520px] max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Coins className="w-5 h-5 text-[var(--primary)]" />
            积分使用规则
          </DialogTitle>
        </DialogHeader>

        {loading && (
          <div className="py-8 text-center text-sm text-[var(--muted-foreground)]">
            加载中...
          </div>
        )}

        {!loading && rules && (
          <div className="space-y-5 pt-2">
            {/* 核心规则：1元=多少积分 */}
            <div className="bg-[var(--primary)]/5 border border-[var(--primary)]/20 rounded-xl p-4">
              <div className="flex items-center gap-2 mb-2">
                <Coins className="w-4 h-4 text-[var(--primary)]" />
                <span className="text-sm font-semibold text-[var(--foreground)]">积分汇率</span>
              </div>
              <div className="text-2xl font-bold text-[var(--primary)]">
                1元 = {rules.creditsPerYuan}积分
              </div>
              <div className="text-xs text-[var(--muted-foreground)] mt-1">
                100元 = {fmtNum(rules.creditsPerYuan * 100)}积分
              </div>
            </div>

            {/* 核心规则：1积分=多少tokens */}
            <div>
              <div className="flex items-center gap-2 mb-3">
                <Zap className="w-4 h-4 text-[var(--primary)]" />
                <span className="text-sm font-semibold text-[var(--foreground)]">积分兑换Token</span>
              </div>
              <div className="grid grid-cols-3 gap-3">
                <div className="bg-[var(--card)] rounded-xl p-3 text-center border border-[var(--border)]">
                  <div className="flex items-center justify-center gap-1 mb-1">
                    <Database className="w-3 h-3 text-[var(--muted-foreground)]" />
                    <span className="text-[10px] text-[var(--muted-foreground)]">输入</span>
                  </div>
                  <div className="text-lg font-bold text-[var(--primary)]">
                    {fmtNum(rules.tokensPerCreditInput)}
                  </div>
                  <div className="text-[10px] text-[var(--muted-foreground)]">tokens/积分</div>
                </div>
                <div className="bg-[var(--card)] rounded-xl p-3 text-center border border-[var(--border)]">
                  <div className="flex items-center justify-center gap-1 mb-1">
                    <Zap className="w-3 h-3 text-[var(--muted-foreground)]" />
                    <span className="text-[10px] text-[var(--muted-foreground)]">输出</span>
                  </div>
                  <div className="text-lg font-bold text-[var(--primary)]">
                    {fmtNum(rules.tokensPerCreditOutput)}
                  </div>
                  <div className="text-[10px] text-[var(--muted-foreground)]">tokens/积分</div>
                </div>
                <div className="bg-[var(--card)] rounded-xl p-3 text-center border border-[var(--border)]">
                  <div className="flex items-center justify-center gap-1 mb-1">
                    <Clock className="w-3 h-3 text-[var(--muted-foreground)]" />
                    <span className="text-[10px] text-[var(--muted-foreground)]">缓存</span>
                  </div>
                  <div className="text-lg font-bold text-[var(--primary)]">
                    {fmtNum(rules.tokensPerCreditCached)}
                  </div>
                  <div className="text-[10px] text-[var(--muted-foreground)]">tokens/积分</div>
                </div>
              </div>
            </div>

            {/* 每千token扣积分明细 */}
            <div>
              <div className="flex items-center gap-2 mb-2">
                <Info className="w-4 h-4 text-[var(--muted-foreground)]" />
                <span className="text-xs font-medium text-[var(--muted-foreground)]">每千Token扣积分</span>
              </div>
              <div className="bg-[var(--card)] rounded-lg border border-[var(--border)] overflow-hidden text-xs">
                <div className="flex justify-between items-center py-2 px-3 border-b border-[var(--border)]/50">
                  <span className="text-[var(--muted-foreground)]">输入 Token</span>
                  <span className="text-[var(--foreground)] font-medium">{rules.inputCreditsPer1k} 积分</span>
                </div>
                <div className="flex justify-between items-center py-2 px-3 border-b border-[var(--border)]/50">
                  <span className="text-[var(--muted-foreground)]">输出 Token</span>
                  <span className="text-[var(--foreground)] font-medium">{rules.outputCreditsPer1k} 积分</span>
                </div>
                <div className="flex justify-between items-center py-2 px-3">
                  <span className="text-[var(--muted-foreground)]">缓存命中 Token</span>
                  <span className="text-[var(--foreground)] font-medium">{rules.cachedCreditsPer1k} 积分</span>
                </div>
              </div>
            </div>

            {/* Token取整规则 */}
            {rules.tokenRoundingUnit > 0 && (
              <div className="bg-[var(--primary)]/5 border border-[var(--primary)]/20 rounded-lg p-3">
                <div className="text-xs font-medium text-[var(--primary)] mb-1">Token取整规则</div>
                <div className="text-[11px] text-[var(--muted-foreground)]">
                  {rules.roundingDescription}
                </div>
              </div>
            )}

            {/* 充值参考示例 */}
            <div>
              <div className="flex items-center gap-2 mb-2">
                <Coins className="w-4 h-4 text-[var(--muted-foreground)]" />
                <span className="text-xs font-medium text-[var(--muted-foreground)]">充值参考</span>
              </div>
              <div className="bg-[var(--card)] rounded-lg border border-[var(--border)] overflow-hidden text-xs">
                <div className="grid grid-cols-4 gap-1 py-2 px-3 border-b border-[var(--border)] text-[var(--muted-foreground)]">
                  <span>充值</span>
                  <span className="text-right">积分</span>
                  <span className="text-right">≈输入</span>
                  <span className="text-right">≈输出</span>
                </div>
                {rules.rechargeExamples.map((ex) => (
                  <div key={ex.yuan} className="grid grid-cols-4 gap-1 py-2 px-3 border-b border-[var(--border)]/50 last:border-0">
                    <span className="text-[var(--foreground)] font-medium">¥{ex.yuan}</span>
                    <span className="text-right text-[var(--primary)] font-medium">{fmtNum(ex.credits)}</span>
                    <span className="text-right text-[var(--secondary-foreground)]">≈{fmtNum(ex.approxInputTokens)}</span>
                    <span className="text-right text-[var(--secondary-foreground)]">≈{fmtNum(ex.approxOutputTokens)}</span>
                  </div>
                ))}
              </div>
            </div>

            {/* 底部说明 */}
            <div className="text-[10px] text-[var(--muted-foreground)] text-center pt-1">
              实际消耗取决于对话内容长度和模型类型，以上为参考值
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
