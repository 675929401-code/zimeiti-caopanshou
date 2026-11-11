/** Member copy is keyed by the platform contract, never by matching internal diagnostics. */
const fieldMessages: Record<string, Record<string, string>> = {
  facebook: { feed_targeting: "本次发布不能按这些条件限制受众。请移除此设置后继续；如需限定受众，请在 Facebook 完成发布。" },
  instagram: {
    caption: "这份稿件包含另一份配文。请把需要发布的文字填写到本账号的正文中，再移除这一项设置。",
    product_tags: "当前发布方式不能添加商品标签。请移除这一项后发布，或前往 Instagram 添加标签。",
    user_tags: "当前发布方式不能在媒体上标记用户。请移除这一项后发布，或前往 Instagram 完成标记。",
    collaborators: "当前发布方式不能邀请协作者。请移除这一项后发布，或前往 Instagram 邀请协作者。",
  },
};
export function memberFieldRestriction(platform: string, field: string) {
  return fieldMessages[platform]?.[field] || "当前发布方式不能使用这一项设置。请移除后继续，或前往平台完成发布。";
}
export function memberPlatformRestriction(platform: string) {
  return platform === "wxGzh" ? "当前无法确认目标公众号，已暂停提交以避免发错账号。请前往微信公众平台发布；已编辑内容可以保存为草稿。" : "请在平台账号中核对授权后继续发布。";
}
