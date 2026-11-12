import type { SocialAccount } from '@/api/accounts/account.types'
import { CheckCircleOutlined, WarningOutlined } from '@ant-design/icons'
import { AccountStatus } from '@/app/config/accountConfig'
import { useTransClient } from '@/app/i18n/client'

function AccountStatusView({ account }: { account: SocialAccount }) {
  const { t } = useTransClient('account')
  if (account.nativeAccountKind === 'generic') return <span className="flex items-center gap-1 text-xs text-muted-foreground"><CheckCircleOutlined className="text-xs" />{account.nativeConnectionCurrent === false ? '原服务连接 · 仅历史核对' : account.nativeBindingStatus === 'disconnected' ? '已从本工作台断开' : account.nativeBindingStatus === 'unknown' ? '官方连接待核对' : '官方已绑定 · 发布尚未开放'}</span>
  if (account.nativeConnectionState === 'official_bound' || account.nativeAccountKind === 'official') return <span className="flex items-center gap-1 text-xs text-muted-foreground"><CheckCircleOutlined className="text-xs" />已绑定 · 发布前核验</span>
  if (account.nativeConnectionState === 'browser_reported' || account.nativeAccountKind === 'browser' && !account.nativeConnectionState) return <span className="flex items-center gap-1 text-xs text-muted-foreground"><WarningOutlined className="text-xs" />已登记 · 待核验当前浏览器</span>
  if (account.nativeConnectionState === 'browser_mismatch') return <span className="flex items-center gap-1 text-xs text-warning"><WarningOutlined className="text-xs" />当前浏览器为其他账号</span>
  if (account.status === AccountStatus.USABLE) {
    return (
      <span className="flex items-center gap-1 text-xs text-success">
        <CheckCircleOutlined className="text-xs" />
        {t('online')}
      </span>
    )
  }

  return (
    <span className="flex items-center gap-1 text-xs text-warning">
      <WarningOutlined className="text-xs" />
      {t('offline')}
    </span>
  )
}

export default AccountStatusView
