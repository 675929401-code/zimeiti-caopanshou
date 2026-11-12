import type { PluginPlatformType } from '@/store/plugin/types/baseTypes'

export interface XhsLoginStatus {
  home: boolean
  creator: boolean
}

export interface WxSphLoginStatus {
  channels: boolean
}

export interface PlatAccountInfo {
  type: PluginPlatformType
  uid: string
  account: string
  avatar: string
  nickname: string
  fansCount?: number
  xhsLoginStatus?: XhsLoginStatus
  wxSphLoginStatus?: WxSphLoginStatus
}
