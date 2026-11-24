'use client';
import { useEffect, useState } from 'react';
import { Settings2 } from 'lucide-react';

const REQUIRED = ['agents.view', 'prompts.view', 'models.view'];

/** 侧栏管理入口：仅对拥有带货后台权限的账号显示，普通会员不渲染。 */
export function RailAdminLink() {
  const [allowed, setAllowed] = useState(false);
  useEffect(() => {
    const token = localStorage.getItem('auth_token') || '';
    if (!token) return;
    let cancelled = false;
    fetch('/api/admin/access-control/self', { headers: { Authorization: 'Bearer ' + token }, cache: 'no-store' })
      .then(response => (response.ok ? response.json() : null))
      .then(body => {
        if (!cancelled && body && REQUIRED.every(key => body.access?.permissionKeys?.includes(key))) setAllowed(true);
      })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, []);
  if (!allowed) return null;
  return <a className="cs-rail-admin" href="/commerce/manage" title="带货管理后台" aria-label="带货管理后台"><Settings2 size={18} /></a>;
}
