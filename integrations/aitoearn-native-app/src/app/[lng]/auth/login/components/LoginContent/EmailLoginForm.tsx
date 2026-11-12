"use client"
import { Button } from '@/components/ui/button'
import { navigateToHostLogin } from '@/integration/host-session'
interface EmailLoginFormProps { onLoginSuccess?: () => void; redirectUrl?: string; inviteCode?: string; showGoogleLogin?: boolean }
/** Membership remains owned by the main site. Original modal markup is retained by LoginDialog. */
export function EmailLoginForm(_props: EmailLoginFormProps = {}) {
  return <div className="space-y-4"><p className="text-center text-sm text-muted-foreground">使用主站会员账号继续，作品、模型与钱包权限统一管理。</p><Button type="button" className="w-full" onClick={navigateToHostLogin}>前往主站登录</Button></div>
}
