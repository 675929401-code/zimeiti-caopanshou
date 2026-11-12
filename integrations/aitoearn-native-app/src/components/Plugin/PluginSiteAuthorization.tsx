'use client'
import { useEffect, useState } from 'react'
import { Check, Copy } from 'lucide-react'
import { Button } from '@/components/ui/button'

/** Domain authorization is local to each member's browser; no second product account is required. */
export function PluginSiteAuthorization() {
 const [origin, setOrigin] = useState(''), [copied, setCopied] = useState(false)
 useEffect(() => { setOrigin(window.location.origin + '/') }, [])
 const copy = async () => { try { await navigator.clipboard.writeText(origin); setCopied(true) } catch { setCopied(false) } }
 return <div className="mt-5 w-full max-w-sm rounded-lg border border-border bg-muted/40 p-4 text-left text-sm text-foreground" data-testid="native-plugin-site-authorization">
  <p className="font-medium">安装后，将插件授权给本站</p>
  <ol className="mt-2 list-decimal space-y-2 pl-5 text-xs leading-relaxed text-muted-foreground">
   <li>打开插件侧栏，选择 Authorize Only（仅授权）。</li>
   <li>在“允许注入的域名”中填入下方本站地址，然后确认授权。</li>
   <li>刷新发布中心，并在同一浏览器登录要发布的小红书或视频号账号。</li>
  </ol>
  <div className="mt-3 flex items-center gap-2"><input aria-label="插件授权的本站地址" readOnly value={origin} className="min-w-0 flex-1 rounded-md border border-input bg-background px-2 py-2 text-xs text-foreground" /><Button type="button" variant="outline" size="sm" disabled={!origin} onClick={() => { void copy() }} aria-label="复制插件授权地址">{copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}{copied ? '已复制' : '复制'}</Button></div>
  <p className="mt-3 text-xs leading-relaxed text-muted-foreground">继续使用本站会员账号，无需再注册或登录 AiToEarn 网页账号。小红书需要同时登录主页与创作者中心。</p>
 </div>
}
