export type BillingSourceCategoryKey =
  | "online_payment"
  | "admin_adjustment"
  | "usage_billing"
  | "trial_grant"
  | "card_redeem"
  | "refund"
  | "system_adjustment"
  | "system_test"
  | "other";

export type BillingSourceCategory = {
  key: BillingSourceCategoryKey;
  label: string;
  description: string;
  rawSources: readonly string[];
  tone: "green" | "blue" | "orange" | "purple" | "cyan" | "red" | "gray";
  contextual?: boolean;
};

/**
 * Stable display taxonomy for balance audit provenance.
 *
 * Raw writer codes stay immutable and visible for reconciliation.  Multiple
 * historical codes may map to one administrator-facing business category.
 * `system_test` is account context (not a writer code), while `other` is the
 * explicit fail-safe for legacy or unregistered values.
 */
export const BILLING_SOURCE_CATEGORIES: readonly BillingSourceCategory[] = Object.freeze([
  {
    key: "online_payment",
    label: "在线支付到账",
    description: "支付平台回调核验成功后产生的到账记录。",
    rawSources: ["payment_callback"],
    tone: "green",
  },
  {
    key: "admin_adjustment",
    label: "管理员人工调整",
    description: "管理员确认后执行的积分或现金充值、扣减与目标余额调整。",
    rawSources: ["admin_manual", "admin_deduction"],
    tone: "blue",
  },
  {
    key: "usage_billing",
    label: "业务使用计费",
    description: "文本、图片或视频等业务调用完成后的实际消费扣费。",
    rawSources: ["billing_deduction", "video_billing", "image_billing"],
    tone: "orange",
  },
  {
    key: "trial_grant",
    label: "试用权益发放",
    description: "试用套餐激活时按套餐快照发放的权益。",
    rawSources: ["trial_plan", "trial_activation"],
    tone: "purple",
  },
  {
    key: "card_redeem",
    label: "卡密兑换",
    description: "有效卡密经原子兑换后发放的积分或现金权益。",
    rawSources: ["cami_redeem"],
    tone: "cyan",
  },
  {
    key: "refund",
    label: "退款/退回",
    description: "失败、取消或退款流程核验后退回的余额。",
    rawSources: ["refund"],
    tone: "red",
  },
  {
    key: "system_adjustment",
    label: "系统校正",
    description: "具有明确系统操作标识的自动校正记录。",
    rawSources: ["system_adjustment"],
    tone: "gray",
  },
  {
    key: "system_test",
    label: "系统测试",
    description: "由隔离测试、E2E 或验收账号产生；仍同时保留底层原始来源代码。",
    rawSources: [],
    tone: "purple",
    contextual: true,
  },
  {
    key: "other",
    label: "其他",
    description: "旧版未归因记录或尚未登记的原始来源；必须显示原值与不能归因的原因。",
    rawSources: ["unknown"],
    tone: "gray",
  },
]);

const CATEGORY_BY_KEY = new Map(BILLING_SOURCE_CATEGORIES.map((item) => [item.key, item]));
const CATEGORY_BY_RAW_SOURCE = new Map(
  BILLING_SOURCE_CATEGORIES.flatMap((item) => item.rawSources.map((source) => [source, item] as const)),
);

export function billingSourceCategoryByKey(value: unknown): BillingSourceCategory | null {
  return CATEGORY_BY_KEY.get(String(value || "").trim() as BillingSourceCategoryKey) || null;
}

export function rawSourcesForBillingCategory(value: unknown): readonly string[] | null {
  const category = billingSourceCategoryByKey(value);
  if (!category || category.contextual || category.key === "other") return null;
  return category.rawSources;
}

export function normalizeBillingSource(input: {
  rawSource: unknown;
  sourceId?: unknown;
  accountIsFixture?: boolean;
}): BillingSourceCategory & { rawSource: string; explanation: string } {
  const rawSource = String(input.rawSource || "").trim() || "unknown";
  const sourceId = String(input.sourceId || "").trim();
  const mapped = CATEGORY_BY_RAW_SOURCE.get(rawSource);

  if (input.accountIsFixture) {
    const testCategory = CATEGORY_BY_KEY.get("system_test")!;
    return {
      ...testCategory,
      rawSource,
      explanation: `该用户是测试/验收账号；底层原始来源为 ${rawSource}${sourceId ? `，操作标识为 ${sourceId}` : ""}。`,
    };
  }

  if (mapped && mapped.key !== "other") {
    return {
      ...mapped,
      rawSource,
      explanation: `${mapped.description}${sourceId ? ` 操作标识：${sourceId}。` : ""}`,
    };
  }

  const other = CATEGORY_BY_KEY.get("other")!;
  const legacyMissing = rawSource === "unknown" && !sourceId;
  return {
    ...other,
    rawSource,
    explanation: legacyMissing
      ? "旧版余额投影没有保存来源代码、操作标识或操作者，无法在不猜测的情况下反推；已按“其他”保留并等待原始凭证核对。"
      : `原始来源代码“${rawSource}”不在当前标准目录中${sourceId ? `，操作标识为 ${sourceId}` : ""}；系统保留原值，不擅自归类。`,
  };
}

