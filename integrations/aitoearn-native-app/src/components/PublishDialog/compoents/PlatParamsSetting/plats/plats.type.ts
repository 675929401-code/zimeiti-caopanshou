import type { PubItem } from '@/components/PublishDialog/publishDialog.type'

export type IPlatsParamsRef = object

export interface IPlatsParamsProps {
  pubItem: PubItem
  // 是否为移动端
  isMobile?: boolean
}
