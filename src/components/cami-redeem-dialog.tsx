'use client';

import { useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';

interface CamiRedeemDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onRedeemed?: () => void;
}

export function CamiRedeemDialog({ open, onOpenChange, onRedeemed }: CamiRedeemDialogProps) {
  const [code, setCode] = useState('');
  const [redeeming, setRedeeming] = useState(false);
  const [result, setResult] = useState<{
    success: boolean;
    message: string;
    credits?: number;
    cash_balance?: number;
    duration_days?: number;
    plan_name?: string;
    allowed_categories?: string[];
    allowed_category_names?: string[];
  } | null>(null);

  const handleRedeem = async () => {
    if (!code.trim()) return;
    setRedeeming(true);
    setResult(null);
    try {
      const token = localStorage.getItem('auth_token');
      const requestId = `cami-dialog:${crypto.randomUUID()}`;
      const resp = await fetch('/api/cami', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
          'Idempotency-Key': requestId,
        },
        body: JSON.stringify({ code: code.trim().toUpperCase(), client_request_id: requestId }),
      });
      const data = await resp.json();
      setResult(data);
      if (data.success) {
        setCode('');
        onRedeemed?.();
      }
    } catch {
      setResult({ success: false, message: '网络错误，请重试' });
    } finally {
      setRedeeming(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[420px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <svg className="w-5 h-5 text-[var(--primary)]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 5v2m0 4v2m0 4v2M5 5a2 2 0 00-2 2v3a2 2 0 110 4v3a2 2 0 002 2h14a2 2 0 002-2v-3a2 2 0 110-4V7a2 2 0 00-2-2H5z" />
            </svg>
            卡密兑换
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div>
            <label className="text-sm font-medium text-[var(--foreground)] mb-1.5 block">输入卡密</label>
            <input
              className="w-full px-4 py-2.5 rounded-xl border border-[var(--border)] bg-[var(--input)] text-[var(--foreground)] text-sm focus:outline-none focus:ring-2 focus:ring-[var(--primary)]/50 uppercase tracking-[0.15em] text-center font-mono placeholder:tracking-normal placeholder:font-sans placeholder:normal-case"
              placeholder="输入卡密码（支持粘贴自动清理）"
              value={code}
              onChange={(e) => setCode(e.target.value.toUpperCase())}
              onKeyDown={(e) => e.key === 'Enter' && handleRedeem()}
              maxLength={35}
              autoFocus
            />
          </div>

          <button
            onClick={handleRedeem}
            disabled={redeeming || !code.trim()}
            className="w-full py-2.5 rounded-xl bg-[var(--primary)] text-white font-medium text-sm hover:bg-[var(--primary)]/90 transition disabled:opacity-50"
          >
            {redeeming ? '兑换中...' : '立即兑换'}
          </button>

          {result && (
            <div className={`p-4 rounded-xl ${result.success ? 'bg-emerald-500/10 border border-emerald-500/20' : 'bg-red-500/10 border border-red-500/20'}`}>
              <p className={`text-sm font-medium ${result.success ? 'text-emerald-400' : 'text-red-400'}`}>
                {result.message}
              </p>
              {result.success && (
                <div className="mt-2 space-y-1">
                  {(result.credits ?? 0) > 0 && <p className="text-xs text-emerald-400/70">+{result.credits} 积分</p>}
                  {(result.cash_balance ?? 0) > 0 && <p className="text-xs text-emerald-400/70">+¥{result.cash_balance} 现金余额</p>}
                  {result.duration_days === 0 && <p className="text-xs text-emerald-400/70">永久会员</p>}
                  {(result.duration_days ?? 0) > 0 && <p className="text-xs text-emerald-400/70">+{result.duration_days} 天会员</p>}
                  {result.plan_name && <p className="text-xs text-emerald-400/50">套餐：{result.plan_name}</p>}
                  {Array.isArray(result.allowed_categories) && result.allowed_categories.length > 0 && (
                    <p className="text-xs text-emerald-400/70">
                      已开通导航：{Array.isArray(result.allowed_category_names) && result.allowed_category_names.length > 0
                        ? result.allowed_category_names.join('、')
                        : `${result.allowed_categories.length}项导航`}
                    </p>
                  )}
                </div>
              )}
            </div>
          )}

          <p className="text-xs text-[var(--text-secondary)] text-center">
            会员卡密用于激活会员；邀请礼包由管理员另行确认发放
          </p>
        </div>
      </DialogContent>
    </Dialog>
  );
}
