'use client';

import React, { useState } from 'react';
import Button from '@/components/ui/Button';
import Input from '@/components/ui/Input';
import { useRouter } from 'next/navigation';

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [name, setName] = useState('');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    const endpoint = mode === 'login' ? '/voice-platform/api/auth/login' : '/voice-platform/api/auth/register';
    const body = mode === 'login'
      ? { email, password }
      : { email, password, name };

    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json();

      if (data.success) {
        localStorage.setItem('token', data.data.token);
        localStorage.setItem('user', JSON.stringify(data.data.user));
        router.push('/workspace');
      } else {
        setError(data.message || '操作失败');
      }
    } catch {
      setError('网络错误，请重试');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-[80vh] flex items-center justify-center px-4">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <div className="w-12 h-12 mx-auto bg-sky-300 rounded-xl flex items-center justify-center mb-4">
            <svg className="w-7 h-7 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" />
            </svg>
          </div>
          <h1 className="text-2xl font-bold text-vp-foreground">{mode === 'login' ? '登录' : '注册'}</h1>
          <p className="text-sm text-vp-muted-foreground mt-1">智音工坊 - AI智能配音工作台</p>
        </div>

        <div className="bg-vp-card/80 rounded-2xl border border-vp-border shadow-sm p-6">
          {error && (
            <div className="bg-red-50 border border-red-200 rounded-xl p-3 text-sm text-red-700 mb-4">{error}</div>
          )}

          <form onSubmit={handleSubmit} className="space-y-4">
            {mode === 'register' && (
              <Input
                label="昵称"
                type="text"
                placeholder="你的昵称"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            )}
            <Input
              label="邮箱"
              type="email"
              placeholder="your@email.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
            <Input
              label="密码"
              type="password"
              placeholder="至少6位密码"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />

            <Button type="submit" variant="primary" size="lg" loading={loading} className="w-full">
              {mode === 'login' ? '登录' : '注册'}
            </Button>
          </form>

          <div className="mt-4 text-center">
            <button
              onClick={() => { setMode(mode === 'login' ? 'register' : 'login'); setError(''); }}
              className="text-sm text-vp-primary hover:text-vp-primary"
            >
              {mode === 'login' ? '没有账号？立即注册' : '已有账号？立即登录'}
            </button>
          </div>

          {/* Demo account hint */}
          <div className="mt-6 pt-4 border-t border-vp-border">
            <p className="text-xs text-vp-muted-foreground text-center">
              演示账号：admin@voicestudio.com / admin123456
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
