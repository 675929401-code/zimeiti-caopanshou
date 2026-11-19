import { providerEnvironmentForPlatform } from "@/lib/publishing-regions"
import type { StudioAccount, StudioPlatform } from "./types"

type RoutedAccount = Pick<StudioAccount, "kind" | "platform">

export function groupStudioPublishingAccounts<T extends RoutedAccount>(accounts: readonly T[]) {
  const domestic: T[] = [], international: T[] = []
  for (const account of accounts) {
    const region = account.kind === "generic" ? providerEnvironmentForPlatform(account.platform) : "domestic"
    const group = region === "international" ? international : domestic
    group.push(account)
  }
  return [{ environment: "domestic", accounts: domestic }, { environment: "international", accounts: international }] as const
}

export function studioTargetBlock(account: StudioAccount, platform: StudioPlatform | undefined) {
  if (account.status !== "ready") return "请先核对该账号的授权"
  if (!platform?.available) return platform?.reason || "账号尚不可发布"
  if (platform.channels?.length) {
    const channel = platform.channels.find(value => value.transport === (account.kind === "browser" ? "browser_plugin" : "official_api"))
    if (!channel?.publishAllowed) return channel?.reason || "此账号的发布通道尚未开放"
  }
}
