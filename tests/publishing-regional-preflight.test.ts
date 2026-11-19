import assert from "node:assert/strict"
import test from "node:test"
import { groupStudioPublishingAccounts, studioTargetBlock } from "../src/features/publishing/studio/studio-routing"
import type { StudioAccount, StudioPlatform } from "../src/features/publishing/studio/types"

test("one confirmation partitions domestic and international accounts without losing local browser targets", () => {
  const bilibili = { platform: "bilibili", kind: "generic" } as const
  const youtube = { platform: "youtube", kind: "generic" } as const
  const xhs = { platform: "xhs", kind: "browser" } as const
  const wxSph = { platform: "wxSph", kind: "browser" } as const
  const tiktok = { platform: "tiktok", kind: "generic" } as const
  assert.deepEqual(groupStudioPublishingAccounts([youtube, xhs, bilibili, tiktok, wxSph]), [
    { environment: "domestic", accounts: [xhs, bilibili, wxSph] },
    { environment: "international", accounts: [youtube, tiktok] },
  ])
})

test("a connected Douyin account cannot borrow availability from the other transport", () => {
  const account = { platform: "douyin", status: "ready", kind: "official" } as StudioAccount
  const browser = { transport: "browser_plugin", connectionAllowed: true, publishAllowed: true, reason: "" } as const
  const official = { transport: "official_api", connectionAllowed: true, publishAllowed: false, reason: "官方通道暂未开放" } as const
  const platform = { key: "douyin", available: true, channels: [browser, official] } as StudioPlatform
  assert.equal(studioTargetBlock(account, platform), official.reason)
  assert.match(studioTargetBlock(account, { ...platform, channels: [browser] }) ?? "", /尚未开放/)
  assert.equal(studioTargetBlock({ ...account, kind: "browser" }, platform), undefined)
})
