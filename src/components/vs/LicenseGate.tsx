'use client';

import { useState, useEffect, useCallback } from 'react';

interface LicenseInfo {
  hasActiveLicense: boolean;
  activeLicense: {
    id: string;
    licenseKey: string;
    maxTrainings: number;
    usedTrainings: number;
    remaining: number;
    voiceType: string | null;
    voiceName: string | null;
    speakerId: string | null;
  } | null;
}

interface LicenseGateProps {
  children: React.ReactNode;
  /** 页面类型：clone 或 design */
  pageType: 'clone' | 'design';
}

/**
 * 授权密钥门控组件
 * - 无有效密钥时：显示密钥激活卡片
 * - 有有效密钥时：显示剩余训练次数 + 渲染 children
 */
export default function LicenseGate({ children, pageType }: LicenseGateProps) {
  const [licenseInfo, setLicenseInfo] = useState<LicenseInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [inputKey, setInputKey] = useState('');
  const [activating, setActivating] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  const getAuthHeaders = useCallback((): HeadersInit | null => {
    const token = localStorage.getItem('auth_token');
    return token ? { Authorization: `Bearer ${token}` } : null;
  }, []);

  const fetchLicense = useCallback(async () => {
    const headers = getAuthHeaders();
    if (!headers) {
      setLicenseInfo({ hasActiveLicense: false, activeLicense: null });
      setLoading(false);
      return;
    }

    try {
      const res = await fetch('/api/voice/license', { headers });
      if (res.status === 401 || res.status === 403) {
        setLicenseInfo({ hasActiveLicense: false, activeLicense: null });
        return;
      }
      const data = await res.json();
      if (data.success) {
        setLicenseInfo(data.data);
      }
    } catch {
      // 静默失败
    } finally {
      setLoading(false);
    }
  }, [getAuthHeaders]);

  useEffect(() => {
    fetchLicense();
  }, [fetchLicense]);

  const handleActivate = async () => {
    if (!inputKey.trim()) {
      setError('请输入密钥');
      return;
    }
    const headers = getAuthHeaders();
    if (!headers) {
      setError('Please login before activating a license.');
      return;
    }
    setActivating(true);
    setError('');
    setSuccess('');
    try {
      const res = await fetch('/api/voice/license', {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ licenseKey: inputKey.trim() }),
      });
      const data = await res.json();
      if (data.success) {
        setSuccess(data.message || '密钥激活成功！');
        setInputKey('');
        fetchLicense();
      } else {
        setError(data.message || '激活失败');
      }
    } catch {
      setError('网络错误，请重试');
    } finally {
      setActivating(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="text-[var(--vs-text-muted)] text-sm">正在检查授权状态...</div>
      </div>
    );
  }

  // 有有效密钥 — 显示训练次数 + 渲染子内容
  if (licenseInfo?.hasActiveLicense && licenseInfo.activeLicense) {
    const lic = licenseInfo.activeLicense;
    return (
      <>
        {/* 密钥状态条 */}
        <div className="mb-6 rounded-2xl border border-[var(--vs-border)] bg-[var(--vs-surface)]/40 px-5 py-3 flex items-center gap-4">
          <div className="flex items-center gap-2">
            <svg className="w-4 h-4 text-emerald-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M9 12l2 2 4-4" />
              <circle cx="12" cy="12" r="10" />
            </svg>
            <span className="text-sm font-semibold text-[var(--vs-text)]">授权已激活</span>
          </div>
          <div className="h-4 w-px bg-[var(--vs-border)]" />
          <code className="text-xs font-mono text-[var(--vs-text-muted)] bg-[var(--vs-surface)] px-2 py-0.5 rounded">
            {lic.licenseKey}
          </code>
          <div className="flex-1" />
          <div className="flex items-center gap-3 text-sm">
            <span className="text-[var(--vs-text-muted)]">
              训练次数：
              <span className="font-bold text-[var(--vs-primary)]">{lic.remaining}</span>
              <span className="text-[var(--vs-text-muted)]"> / {lic.maxTrainings}</span>
            </span>
            {/* 进度条 */}
            <div className="w-24 h-1.5 rounded-full bg-[var(--vs-surface)] overflow-hidden">
              <div
                className="h-full rounded-full bg-gradient-to-r from-[var(--vs-primary)] to-[var(--vs-glow)] transition-all duration-300"
                style={{ width: `${(lic.remaining / lic.maxTrainings) * 100}%` }}
              />
            </div>
          </div>
        </div>
        {children}
      </>
    );
  }

  // 无有效密钥 — 显示激活卡片
  const pageTitle = pageType === 'clone' ? '声音复刻' : '声音设计';
  return (
    <div className="max-w-lg mx-auto py-12">
      <div className="rounded-3xl border border-[var(--vs-border)] bg-[var(--vs-surface)]/40 p-8 text-center">
        {/* 图标 */}
        <div className="w-16 h-16 mx-auto mb-5 rounded-2xl bg-gradient-to-br from-[var(--vs-primary)]/20 to-[var(--vs-glow)]/20 flex items-center justify-center">
          <svg className="w-8 h-8 text-[var(--vs-primary)]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="11" width="18" height="11" rx="2" />
            <path d="M7 11V7a5 5 0 0110 0v4" />
          </svg>
        </div>

        <h2 className="text-xl font-bold text-[var(--vs-text)] mb-2">
          {pageTitle}需要授权密钥
        </h2>
        <p className="text-sm text-[var(--vs-text-muted)] mb-6 leading-relaxed">
          请输入管理员发放的授权密钥来解锁{pageTitle}功能。<br />
          每个密钥包含 15 次模型训练机会，可用于创建自定义音色。
        </p>

        {/* 输入区 */}
        <div className="space-y-3">
          <input
            type="text"
            value={inputKey}
            onChange={(e) => setInputKey(e.target.value.toUpperCase())}
            onKeyDown={(e) => e.key === 'Enter' && handleActivate()}
            placeholder="ZY-XXXX-XXXX"
            className="w-full px-4 py-3 rounded-xl border border-[var(--vs-border)] bg-[var(--vs-bg-secondary)] text-[var(--vs-text)] text-center font-mono text-lg tracking-widest placeholder:text-[var(--vs-text-muted)]/50 focus:outline-none focus:border-[var(--vs-primary)] focus:ring-2 focus:ring-[var(--vs-primary)]/20 transition-all"
            disabled={activating}
          />
          <button
            onClick={handleActivate}
            disabled={activating || !inputKey.trim()}
            className="w-full px-4 py-3 rounded-xl font-semibold text-white bg-gradient-to-r from-[var(--vs-primary)] to-[var(--vs-glow)] hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed transition-all"
          >
            {activating ? '激活中...' : '激活密钥'}
          </button>
        </div>

        {error && (
          <div className="mt-4 px-4 py-2.5 rounded-xl bg-red-500/10 border border-red-500/20 text-red-400 text-sm">
            {error}
          </div>
        )}
        {success && (
          <div className="mt-4 px-4 py-2.5 rounded-xl bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 text-sm">
            {success}
          </div>
        )}

        {/* 说明 */}
        <div className="mt-6 pt-5 border-t border-[var(--vs-border)] text-left">
          <h3 className="text-xs font-semibold text-[var(--vs-text-muted)] mb-2 uppercase tracking-wider">使用说明</h3>
          <ul className="space-y-1.5 text-xs text-[var(--vs-text-muted)]">
            <li className="flex items-start gap-2">
              <span className="text-[var(--vs-primary)] mt-0.5">•</span>
              <span>一个密钥只能绑定一个音色，包含 15 次训练机会</span>
            </li>
            <li className="flex items-start gap-2">
              <span className="text-[var(--vs-primary)] mt-0.5">•</span>
              <span>每次复刻/设计消耗 1 次训练，训练次数用完后需获取新密钥</span>
            </li>
            <li className="flex items-start gap-2">
              <span className="text-[var(--vs-primary)] mt-0.5">•</span>
              <span>创建的音色永久保存在云端，使用音色合成时按字符收费</span>
            </li>
            <li className="flex items-start gap-2">
              <span className="text-[var(--vs-primary)] mt-0.5">•</span>
              <span>如需获取密钥，请联系管理员</span>
            </li>
          </ul>
        </div>
      </div>
    </div>
  );
}
