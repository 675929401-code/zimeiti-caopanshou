import { NextResponse } from "next/server";
import { verifyAdminToken } from "@/lib/admin-auth";
import { getSupabaseClient } from "@/storage/database/supabase-client";

type InvitationRecord = {
  id: string;
  inviter_id: string | null;
  invitee_id: string | null;
  invitee_activated: boolean | null;
  reward_sent: boolean | null;
  invited_at: string | null;
  activated_at: string | null;
  invitation_code_id?: string | null;
  invitation_code_snapshot?: string | null;
  activation_method?: string | null;
  activation_reference?: string | null;
  activation_fee?: number | null;
  activation_note?: string | null;
  activated_by?: string | null;
  registration_ip_hash?: string | null;
  registration_device_hash?: string | null;
  risk_status?: "clear" | "review" | "cleared" | "blocked" | null;
  risk_reasons?: string[] | null;
  automatic_trial_eligible?: boolean | null;
  risk_reviewed_at?: string | null;
  risk_reviewed_by?: string | null;
  risk_review_note?: string | null;
};

type RewardGrant = {
  id: string;
  invitation_record_id: string;
  reward_stage: "registration" | "invitee_welcome" | "activation";
  status: "pending" | "draft" | "sent" | "skipped";
  recipient_user_id: string;
  eligibility_at: string | null;
  credits: number;
  cash_amount: number;
  note: string;
  drafted_at: string | null;
  sent_at: string | null;
  notification_id: string | null;
  package_assignment_id: string | null;
};

type PackageAssignment = {
  id: string;
  invitation_record_id: string;
  profile_key: string | null;
  profile_version: number | null;
  package_name: string;
  membership_status: "trial" | "active";
  duration_days: number;
  member_expires_at: string | null;
  credits: number;
  cash_amount: number;
  feature_navigation_keys: string[];
  agent_navigation_keys: string[];
  permission_revision: number;
  notification_id: string;
  created_at: string;
};

type InvitationUser = {
  id: string;
  username: string | null;
  display_name: string | null;
  phone: string | null;
  email: string | null;
  member_status: string | null;
  credits: number | null;
  cash_balance: number | null;
};

type PendingAction = "risk_review" | "invitee_package" | "registration_reward" | "activation_reward";

type InvitationWorkflow = {
  immediatePending: boolean;
  pendingActions: PendingAction[];
  registrationStageCompleted: boolean;
  waitingForActivation: boolean;
  completed: boolean;
  state: "pending" | "waiting_activation" | "completed" | "blocked";
};

type InvitationViewRecord = {
  record_id: string;
  inviter_id: string | null;
  invitee_id: string | null;
  invitee_activated: boolean;
  invited_at: string | null;
  activated_at: string | null;
  activation_method: string | null;
  activation_fee: number | null;
  activation_note: string | null;
  invitation_code: string | null;
  attribution_status: "exact" | "legacy-derived";
  risk_status: string;
  risk_reasons: string[];
  risk_review_note: string | null;
  risk_reviewed_at: string | null;
  inviter: Partial<InvitationUser>;
  invitee: Partial<InvitationUser>;
  rewards: RewardGrant[];
  package_assignment: PackageAssignment | null;
  workflow: InvitationWorkflow;
};

type InvitationCode = {
  id: string;
  code: string;
  is_used: boolean;
  used_at: string | null;
};

async function requireAdminUserId(request: Request) {
  const authHeader = request.headers.get("authorization");
  if (!authHeader) return null;
  const payload = await verifyAdminToken(authHeader.replace("Bearer ", ""));
  return payload?.userId || null;
}

function serializePolicy(row?: Record<string, unknown> | null) {
  return {
    monthlyCodeLimit: Number(row?.monthly_code_limit || 6),
    riskWindowDays: Number(row?.risk_window_days || 30),
    inviterBurstThreshold: Number(row?.inviter_burst_threshold || 3),
    revision: Number(row?.revision || 1),
    updatedAt: row?.updated_at ? String(row.updated_at) : null,
  };
}

const RECORD_PAGE_SIZE = 500;
const RELATED_QUERY_CHUNK_SIZE = 200;

function chunks<T>(values: T[], size = RELATED_QUERY_CHUNK_SIZE) {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size) result.push(values.slice(index, index + size));
  return result;
}

function rewardClosed(reward?: RewardGrant) {
  return Boolean(reward?.eligibility_at) && (reward?.status === "sent" || reward?.status === "skipped");
}

function normalizePackageReward(rewards: RewardGrant[], assignment?: PackageAssignment | null) {
  if (!assignment) return rewards;
  return rewards.map((reward) => reward.reward_stage !== "invitee_welcome" ? reward : {
    ...reward,
    status: "sent" as const,
    eligibility_at: reward.eligibility_at || assignment.created_at,
    credits: Number(assignment.credits || 0),
    cash_amount: Number(assignment.cash_amount || 0),
    note: reward.note || "会员套餐已实际开通",
    drafted_at: reward.drafted_at || assignment.created_at,
    sent_at: reward.sent_at || assignment.created_at,
    notification_id: reward.notification_id || assignment.notification_id,
    package_assignment_id: assignment.id,
  });
}

function invitationWorkflow(
  row: InvitationRecord,
  rewards: RewardGrant[],
  assignment?: PackageAssignment | null,
): InvitationWorkflow {
  const byStage = new Map(rewards.map((reward) => [reward.reward_stage, reward]));
  const packageCompleted = Boolean(assignment) || rewardClosed(byStage.get("invitee_welcome"));
  const registrationCompleted = rewardClosed(byStage.get("registration"));
  const activationCompleted = rewardClosed(byStage.get("activation"));
  const riskStatus = row.risk_status || "clear";
  const pendingActions: PendingAction[] = [];

  if (riskStatus === "review") {
    pendingActions.push("risk_review");
  } else if (riskStatus !== "blocked") {
    if (!packageCompleted) pendingActions.push("invitee_package");
    if (!registrationCompleted) pendingActions.push("registration_reward");
    if (Boolean(row.invitee_activated) && !activationCompleted) pendingActions.push("activation_reward");
  }

  const registrationStageCompleted = packageCompleted && registrationCompleted;
  const waitingForActivation = riskStatus !== "blocked"
    && !Boolean(row.invitee_activated)
    && registrationStageCompleted;
  const completed = riskStatus !== "blocked"
    && Boolean(row.invitee_activated)
    && registrationStageCompleted
    && activationCompleted;

  return {
    immediatePending: pendingActions.length > 0,
    pendingActions,
    registrationStageCompleted,
    waitingForActivation,
    completed,
    state: riskStatus === "blocked"
      ? "blocked"
      : completed
        ? "completed"
        : waitingForActivation
          ? "waiting_activation"
          : "pending",
  };
}

function formatBeijing(value?: string | null) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).format(date);
}

function csvCell(value: unknown) {
  let text = value == null ? "" : String(value);
  if (/^[=+\-@]/u.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

function csvRewardStatus(reward?: RewardGrant) {
  if (!reward) return "节点缺失";
  if (!reward.eligibility_at) return "等待正式激活";
  return ({ pending: "待处理", draft: "额度已保存待发放", sent: "已入账并通知", skipped: "已处理（本次不发）" } as const)[reward.status];
}

function buildInvitationCsv(records: InvitationViewRecord[], stats: Record<string, number>) {
  const pendingLabels: Record<PendingAction, string> = {
    risk_review: "风险复核",
    invitee_package: "新人会员套餐",
    registration_reward: "邀请注册奖励",
    activation_reward: "正式会员邀请奖励",
  };
  const rows: unknown[][] = [
    ["邀请关系账单汇总", "数值"],
    ["累计受邀注册用户数", stats.totalRecords],
    ["受邀正式会员数", stats.activatedCount],
    ["注册未激活人数", stats.inactiveCount],
    ["产生邀请的会员数", stats.totalInviters],
    ["当前待处理关系数", stats.pendingRecordCount],
    ["当前待处理操作数", stats.pendingActionCount],
    ["已闭环关系数", stats.completedCount],
    ["待风险复核数", stats.riskPending],
    ["导出时间（北京时间）", formatBeijing(new Date().toISOString())],
    [],
    [
      "关系编号", "邀请码", "归因方式", "注册时间", "邀请人编号", "邀请人姓名", "邀请人手机", "邀请人邮箱", "邀请人会员状态",
      "受邀人编号", "受邀人姓名", "受邀人手机", "受邀人邮箱", "受邀人会员状态", "是否正式激活", "正式激活时间", "激活方式", "实收金额", "激活说明",
      "新人套餐", "套餐类型", "套餐有效期", "套餐积分", "套餐现金", "套餐开通时间", "新人套餐节点",
      "注册奖励状态", "注册奖励积分", "注册奖励现金", "注册奖励发放时间",
      "正式奖励状态", "正式奖励积分", "正式奖励现金", "正式奖励发放时间",
      "当前待处理事项", "关系流程状态", "风险状态", "风险原因", "复核备注", "复核时间",
    ],
  ];

  for (const record of records) {
    const rewards = new Map<RewardGrant["reward_stage"], RewardGrant>(
      (record.rewards || []).map((reward) => [reward.reward_stage, reward]),
    );
    const welcome = rewards.get("invitee_welcome");
    const registration = rewards.get("registration");
    const activation = rewards.get("activation");
    const assignment = record.package_assignment;
    rows.push([
      record.record_id, record.invitation_code, record.attribution_status === "exact" ? "注册时精确归因" : "历史关系推导", formatBeijing(record.invited_at),
      record.inviter_id, record.inviter?.display_name || record.inviter?.username, record.inviter?.phone, record.inviter?.email, record.inviter?.member_status,
      record.invitee_id, record.invitee?.display_name || record.invitee?.username, record.invitee?.phone, record.invitee?.email, record.invitee?.member_status,
      record.invitee_activated ? "是" : "否", formatBeijing(record.activated_at), record.activation_method || "", record.activation_fee == null ? "" : Number(record.activation_fee).toFixed(2), record.activation_note,
      assignment?.package_name || "未开通", assignment?.membership_status === "active" ? "正式会员" : assignment?.membership_status === "trial" ? "试用会员" : "", formatBeijing(assignment?.member_expires_at), assignment?.credits ?? "", assignment?.cash_amount ?? "", formatBeijing(assignment?.created_at), csvRewardStatus(welcome),
      csvRewardStatus(registration), registration?.credits ?? "", registration?.cash_amount ?? "", formatBeijing(registration?.sent_at),
      csvRewardStatus(activation), activation?.credits ?? "", activation?.cash_amount ?? "", formatBeijing(activation?.sent_at),
      record.workflow.pendingActions.map((action: PendingAction) => pendingLabels[action]).join("；") || "无",
      record.workflow.state === "completed" ? "已闭环" : record.workflow.state === "waiting_activation" ? "注册阶段完成，等待正式激活" : record.workflow.state === "blocked" ? "风险已拦截" : "待处理",
      record.risk_status, (record.risk_reasons || []).join("；"), record.risk_review_note, formatBeijing(record.risk_reviewed_at),
    ]);
  }
  return `\uFEFF${rows.map((row) => row.map(csvCell).join(",")).join("\r\n")}\r\n`;
}

// GET /api/admin/invitations — 管理员查看邀请记录（含邀请人/被邀请人详情+会员状态）
// 原实现使用 executeSql（PG直连），现改为 Supabase 客户端 + 手动拼合
export async function GET(request: Request) {
  try {
    const supabase = getSupabaseClient();
    const adminUserId = await requireAdminUserId(request);
    if (!adminUserId) {
      return NextResponse.json({ error: "登录已过期" }, { status: 401 });
    }

    // verifyAdminToken already checked the current database role and active state.
    // Read every relation in stable pages. The CSV is a company ledger and must
    // never silently stop at the former 200-row screen limit.
    const policyPromise = supabase
      .from("invitation_security_policies")
      .select("monthly_code_limit, risk_window_days, inviter_burst_threshold, revision, updated_at")
      .eq("policy_key", "default")
      .maybeSingle();
    const records: InvitationRecord[] = [];
    let recErr: { code?: string; message?: string } | null = null;
    for (let offset = 0; ; offset += RECORD_PAGE_SIZE) {
      const page = await supabase
        .from("invitation_records")
        .select("id, inviter_id, invitee_id, invitee_activated, reward_sent, invited_at, activated_at, invitation_code_id, invitation_code_snapshot, activation_method, activation_reference, activation_fee, activation_note, activated_by, registration_ip_hash, registration_device_hash, risk_status, risk_reasons, automatic_trial_eligible, risk_reviewed_at, risk_reviewed_by, risk_review_note")
        .order("invited_at", { ascending: false })
        .order("id", { ascending: false })
        .range(offset, offset + RECORD_PAGE_SIZE - 1);
      if (page.error) {
        recErr = page.error;
        break;
      }
      const pageRows = (page.data || []) as InvitationRecord[];
      records.push(...pageRows);
      if (pageRows.length < RECORD_PAGE_SIZE) break;
    }
    const policyQuery = await policyPromise;

    if (recErr || policyQuery.error) {
      console.error("[Admin Invitations] query error:", recErr || policyQuery.error);
      const code = String((recErr || policyQuery.error)?.code || "");
      const migrationMissing = ["PGRST205", "42P01", "42703"].includes(code);
      return NextResponse.json({
        error: migrationMissing ? "邀请码风控迁移尚未就绪" : "获取邀请记录失败",
        code: migrationMissing ? "INVITATION_SECURITY_MIGRATION_NOT_READY" : "INVITATION_READ_FAILED",
      }, { status: migrationMissing ? 503 : 500 });
    }
    const policy = serializePolicy(policyQuery.data as Record<string, unknown> | null);

    // 2. 收集所有需要查询的用户 ID
    const userIds = [...new Set([
      ...records.map(r => r.inviter_id),
      ...records.map(r => r.invitee_id),
    ].filter(Boolean))];

    // 3. 批量查询用户信息
    const users: InvitationUser[] = [];
    for (const ids of chunks(userIds as string[])) {
      const query = await supabase
        .from("users")
        .select("id, username, display_name, phone, email, member_status, credits, cash_balance")
        .in("id", ids);
      if (query.error) return NextResponse.json({ error: "邀请会员信息读取失败", code: "INVITATION_USER_READ_FAILED" }, { status: 503 });
      users.push(...((query.data || []) as InvitationUser[]));
    }
    const userMap: Record<string, Partial<InvitationUser>> = {};
    (users || []).forEach(u => { userMap[u.id] = u; });

    // 4. 只按关系中留存的 code id 回读，禁止拿邀请人当前的新码冒充历史归因码。
    const invitationCodeIds = [...new Set(records.map(r => r.invitation_code_id).filter(Boolean))];
    const codes: InvitationCode[] = [];
    for (const ids of chunks(invitationCodeIds as string[])) {
      const query = await supabase
        .from("invitation_codes")
        .select("id, code, is_used, used_at")
        .in("id", ids);
      if (query.error) return NextResponse.json({ error: "历史邀请码读取失败", code: "INVITATION_CODE_READ_FAILED" }, { status: 503 });
      codes.push(...((query.data || []) as InvitationCode[]));
    }
    const codeMap: Record<string, InvitationCode> = {};
    (codes || []).forEach(c => { codeMap[c.id] = c; });

    const rewards: RewardGrant[] = [];
    let rewardsError: { code?: string } | null = null;
    for (const ids of chunks(records.map((record) => record.id))) {
      const query = await supabase
        .from("invitation_reward_grants")
        .select("id, invitation_record_id, reward_stage, status, recipient_user_id, eligibility_at, credits, cash_amount, note, drafted_at, sent_at, notification_id, package_assignment_id")
        .in("invitation_record_id", ids);
      if (query.error) {
        rewardsError = query.error;
        break;
      }
      rewards.push(...((query.data || []) as RewardGrant[]));
    }
    if (rewardsError) {
      const migrationMissing = ["PGRST205", "42P01", "42703"].includes(String(rewardsError.code || ""));
      return NextResponse.json({
        error: migrationMissing ? "邀请礼包迁移尚未就绪" : "邀请礼包状态读取失败",
        code: migrationMissing ? "INVITATION_REWARD_MIGRATION_NOT_READY" : "INVITATION_REWARD_READ_FAILED",
      }, { status: 503 });
    }
    const rewardsByRecord = new Map<string, RewardGrant[]>();
    for (const reward of rewards) {
      const current = rewardsByRecord.get(reward.invitation_record_id) || [];
      current.push(reward);
      rewardsByRecord.set(reward.invitation_record_id, current);
    }

    const packageData: PackageAssignment[] = [];
    let packageError: { code?: string } | null = null;
    for (const ids of chunks(records.map((record) => record.id))) {
      const query = await supabase
        .from("member_package_assignments")
        .select("id, invitation_record_id, profile_key, profile_version, package_name, membership_status, duration_days, member_expires_at, credits, cash_amount, feature_navigation_keys, agent_navigation_keys, permission_revision, notification_id, created_at")
        .in("invitation_record_id", ids)
        .order("created_at", { ascending: false });
      if (query.error) {
        packageError = query.error;
        break;
      }
      packageData.push(...((query.data || []) as PackageAssignment[]));
    }
    if (packageError) {
      return NextResponse.json({
        error: "会员套餐状态读取失败",
        code: "MEMBER_PACKAGE_READ_FAILED",
      }, { status: 503 });
    }
    const packageByRecord = new Map<string, PackageAssignment>();
    for (const assignment of packageData) {
      if (!packageByRecord.has(assignment.invitation_record_id)) {
        packageByRecord.set(assignment.invitation_record_id, assignment);
      }
    }

    // 5. 拼合结果
    const result: InvitationViewRecord[] = records.map(row => {
      const inviterId = row.inviter_id || "";
      const inviteeId = row.invitee_id || "";
      const inviter = userMap[inviterId] || {};
      const invitee = userMap[inviteeId] || {};
      const codeInfo = row.invitation_code_id ? codeMap[row.invitation_code_id] : undefined;
      const packageAssignment = packageByRecord.get(row.id) || null;
      const normalizedRewards = normalizePackageReward(
        (rewardsByRecord.get(row.id) || []).sort((left, right) => left.reward_stage.localeCompare(right.reward_stage)),
        packageAssignment,
      );
      const workflow = invitationWorkflow(row, normalizedRewards, packageAssignment);
      return {
        record_id: row.id,
        inviter_id: row.inviter_id,
        invitee_id: row.invitee_id,
        invitee_activated: row.invitee_activated ?? false,
        reward_sent: row.reward_sent ?? false,
        invited_at: row.invited_at,
        activated_at: row.activated_at || null,
        activation_method: row.activation_method || null,
        activation_reference: row.activation_reference || null,
        activation_fee: row.activation_fee == null ? null : Number(row.activation_fee),
        activation_note: row.activation_note || null,
        activated_by: row.activated_by || null,
        invitation_code: row.invitation_code_snapshot || codeInfo?.code || null,
        invitation_code_id: row.invitation_code_id || null,
        attribution_status: row.invitation_code_id && row.invitation_code_snapshot ? "exact" : "legacy-derived",
        invitation_code_status: codeInfo?.is_used ? "consumed" : codeInfo ? "open" : "historical",
        invitation_code_used_at: codeInfo?.used_at || null,
        is_permanent: false,
        risk_status: row.risk_status || "clear",
        risk_reasons: Array.isArray(row.risk_reasons) ? row.risk_reasons : [],
        automatic_trial_eligible: row.automatic_trial_eligible !== false,
        risk_reviewed_at: row.risk_reviewed_at || null,
        risk_reviewed_by: row.risk_reviewed_by || null,
        risk_review_note: row.risk_review_note || null,
        inviter: {
          username: inviter.username || null,
          display_name: inviter.display_name || null,
          phone: inviter.phone || null,
          email: inviter.email || null,
          member_status: inviter.member_status || null,
          credits: inviter.credits || null,
          cash_balance: inviter.cash_balance || null,
        },
        invitee: {
          username: invitee.username || null,
          display_name: invitee.display_name || null,
          phone: invitee.phone || null,
          email: invitee.email || null,
          member_status: invitee.member_status || null,
          credits: invitee.credits || null,
          cash_balance: invitee.cash_balance || null,
        },
        rewards: normalizedRewards,
        package_assignment: packageAssignment,
        workflow,
      };
    });

    // 6. 统计
    const totalRecords = records.length;
    const activatedCount = records.filter(r => r.invitee_activated).length;
    const totalInviters = new Set(records.map(r => r.inviter_id)).size;
    const pendingRecords = result.filter((record) => record.workflow.immediatePending);
    const registrationPending = pendingRecords.filter((record) => record.workflow.pendingActions.includes("registration_reward")).length;
    const welcomePending = pendingRecords.filter((record) => record.workflow.pendingActions.includes("invitee_package")).length;
    const activationPending = pendingRecords.filter((record) => record.workflow.pendingActions.includes("activation_reward")).length;
    const pendingRecordCount = pendingRecords.length;
    const pendingActionCount = pendingRecords.reduce((total, record) => total + record.workflow.pendingActions.length, 0);
    const riskPending = records.filter((record) => record.risk_status === "review").length;
    const completedCount = result.filter((record) => record.workflow.completed).length;
    const inactiveCount = totalRecords - activatedCount;
    const stats = {
      totalRecords,
      activatedCount,
      inactiveCount,
      totalInviters,
      rewardPending: pendingRecordCount,
      pendingRecordCount,
      pendingActionCount,
      completedCount,
      registrationPending,
      welcomePending,
      activationPending,
      riskPending,
    };

    if (new URL(request.url).searchParams.get("format") === "csv") {
      const csv = buildInvitationCsv(result, stats);
      const fileName = `邀请关系账单-${new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Shanghai" })}.csv`;
      return new Response(csv, {
        status: 200,
        headers: {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`,
          "Cache-Control": "no-store",
        },
      });
    }

    return NextResponse.json({ records: result, stats, policy });
  } catch (error) {
    console.error("[Admin Invitations] GET error:", error);
    return NextResponse.json({ error: "获取邀请记录失败" }, { status: 500 });
  }
}

// PUT /api/admin/invitations — 管理员配置每位会员每月可生成 4/5/6 枚邀请码。
export async function PUT(request: Request) {
  try {
    const adminUserId = await requireAdminUserId(request);
    if (!adminUserId) return NextResponse.json({ error: "无管理员权限" }, { status: 403 });
    const body = await request.json();
    const monthlyCodeLimit = Number(body.monthlyCodeLimit);
    const requestKey = String(request.headers.get("idempotency-key") || body.idempotencyKey || "").trim();
    if (![4, 5, 6].includes(monthlyCodeLimit) || !/^[A-Za-z0-9][A-Za-z0-9._:-]{7,179}$/u.test(requestKey)) {
      return NextResponse.json({ error: "月度额度或操作编号无效" }, { status: 400 });
    }
    const database = getSupabaseClient();
    const { data, error } = await database.rpc("set_invitation_security_policy_atomic", {
      p_admin_id: adminUserId,
      p_monthly_code_limit: monthlyCodeLimit,
      p_request_key: requestKey,
    });
    if (error) {
      const missing = ["PGRST202", "42883", "42P01"].includes(String(error.code || ""));
      return NextResponse.json({ error: missing ? "邀请码风控迁移尚未就绪" : "邀请码月度额度保存失败" }, { status: 503 });
    }
    const result = (data || {}) as Record<string, unknown>;
    if (result.success !== true) return NextResponse.json({ error: "邀请码月度额度未通过业务校验", code: result.code }, { status: 400 });
    return NextResponse.json({ success: true, policy: serializePolicy(result) });
  } catch (error) {
    console.error("[Admin Invitations] PUT error:", error);
    return NextResponse.json({ error: "邀请码月度额度保存失败" }, { status: 500 });
  }
}

// PATCH /api/admin/invitations — 人工复核可疑邀请；IP 只作信号，不自动封号。
export async function PATCH(request: Request) {
  try {
    const adminUserId = await requireAdminUserId(request);
    if (!adminUserId) return NextResponse.json({ error: "无管理员权限" }, { status: 403 });
    const body = await request.json();
    const recordId = String(body.recordId || "").trim();
    const decision = String(body.decision || "").trim();
    const note = String(body.note || "").trim().slice(0, 1000);
    const requestKey = String(request.headers.get("idempotency-key") || body.idempotencyKey || "").trim();
    if (!recordId || !["cleared", "blocked"].includes(decision)
      || !/^[A-Za-z0-9][A-Za-z0-9._:-]{7,179}$/u.test(requestKey)) {
      return NextResponse.json({ error: "风险复核参数无效" }, { status: 400 });
    }
    const database = getSupabaseClient();
    const { data, error } = await database.rpc("review_invitation_risk_atomic", {
      p_admin_id: adminUserId,
      p_record_id: recordId,
      p_decision: decision,
      p_note: note,
      p_request_key: requestKey,
    });
    if (error) {
      const missing = ["PGRST202", "42883", "42P01"].includes(String(error.code || ""));
      return NextResponse.json({ error: missing ? "邀请码风控迁移尚未就绪" : "风险复核保存失败" }, { status: 503 });
    }
    const result = (data || {}) as Record<string, unknown>;
    if (result.success !== true) {
      const notFound = result.code === "INVITATION_RECORD_NOT_FOUND";
      return NextResponse.json({ error: notFound ? "邀请关系不存在" : "风险复核未通过业务校验", code: result.code }, { status: notFound ? 404 : 400 });
    }
    return NextResponse.json({ success: true, review: result });
  } catch (error) {
    console.error("[Admin Invitations] PATCH error:", error);
    return NextResponse.json({ error: "风险复核保存失败" }, { status: 500 });
  }
}
