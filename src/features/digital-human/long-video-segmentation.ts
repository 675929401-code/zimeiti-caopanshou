export const ALI_LONG_VIDEO_SEGMENT_SECONDS = 115;
export const ALI_LONG_VIDEO_HARD_MAX_EXCLUSIVE_SECONDS = 120;
export const ALI_LONG_VIDEO_MIN_EXCLUSIVE_SECONDS = 2;

const TIME_PRECISION = 1_000;
const MONEY_PRECISION = 100;

export type LongVideoBoundaryKind = 'manual' | 'silence' | 'sentence';

export type LongVideoBoundary = {
  atSeconds: number;
  kind: LongVideoBoundaryKind;
  confidence?: number;
};

export type LongVideoSegment = {
  ordinal: number;
  startSeconds: number;
  endSeconds: number;
  durationSeconds: number;
  endBoundary: LongVideoBoundaryKind | 'planned' | 'media_end';
};

export type LongVideoPlan = {
  totalDurationSeconds: number;
  segmentCount: number;
  recommendedMaxSegmentSeconds: number;
  hardMaxExclusiveSeconds: number;
  minExclusiveSeconds: number;
  segments: LongVideoSegment[];
};

export type LongVideoQuote = {
  unitPriceYuan: number;
  billableSeconds: number;
  lockedTotalYuan: number;
  segmentEstimates: Array<{ ordinal: number; amountYuan: number }>;
};

export type LongVideoChildState =
  | 'queued'
  | 'dispatching'
  | 'running'
  | 'submission_unknown'
  | 'completed'
  | 'failed'
  | 'cancelled';

export type LongVideoParentPhase =
  | 'queued'
  | 'processing'
  | 'confirming'
  | 'failed'
  | 'cancelled'
  | 'merging'
  | 'ready_to_settle'
  | 'completed';

export class LongVideoPlanError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'LongVideoPlanError';
  }
}

function toTicks(value: number, label: string) {
  if (!Number.isFinite(value) || value <= 0) {
    throw new LongVideoPlanError('DIGITAL_HUMAN_LONG_DURATION_INVALID', `${label}必须是大于 0 的有限秒数。`);
  }
  return Math.round(value * TIME_PRECISION);
}

function fromTicks(value: number) {
  return Number((value / TIME_PRECISION).toFixed(3));
}

function roundMoney(value: number) {
  return Math.round((value + Number.EPSILON) * MONEY_PRECISION) / MONEY_PRECISION;
}

function roundUnitPrice(value: number) {
  return Math.round((value + Number.EPSILON) * 10_000) / 10_000;
}

function boundaryPriority(kind: LongVideoBoundaryKind) {
  return kind === 'manual' ? 3 : kind === 'silence' ? 2 : 1;
}

/**
 * Produces a deterministic plan only. The caller remains responsible for
 * probing silence/sentence boundaries, cutting both owned inputs, dispatching
 * child tasks, merging owned results and settling the parent exactly once.
 */
export function planAliLongDigitalHumanVideo(input: {
  totalDurationSeconds: number;
  boundaries?: LongVideoBoundary[];
  recommendedMaxSegmentSeconds?: number;
  hardMaxExclusiveSeconds?: number;
  minExclusiveSeconds?: number;
  maxBoundaryDriftSeconds?: number;
}): LongVideoPlan {
  const totalTicks = toTicks(input.totalDurationSeconds, '总时长');
  const minTicks = toTicks(input.minExclusiveSeconds ?? ALI_LONG_VIDEO_MIN_EXCLUSIVE_SECONDS, '最短分段');
  const hardMaxTicks = toTicks(
    input.hardMaxExclusiveSeconds ?? ALI_LONG_VIDEO_HARD_MAX_EXCLUSIVE_SECONDS,
    '供应商硬上限',
  );
  const recommendedMaxTicks = toTicks(
    input.recommendedMaxSegmentSeconds ?? ALI_LONG_VIDEO_SEGMENT_SECONDS,
    '建议分段上限',
  );
  const minimumAllowedTicks = minTicks + 1;

  if (recommendedMaxTicks >= hardMaxTicks) {
    throw new LongVideoPlanError(
      'DIGITAL_HUMAN_LONG_SEGMENT_LIMIT_INVALID',
      '建议分段上限必须严格小于供应商硬上限。',
    );
  }
  if (totalTicks < minimumAllowedTicks) {
    throw new LongVideoPlanError(
      'DIGITAL_HUMAN_LONG_DURATION_TOO_SHORT',
      `总时长必须大于 ${fromTicks(minTicks)} 秒。`,
    );
  }

  const segmentCount = Math.ceil(totalTicks / recommendedMaxTicks);
  if (totalTicks < segmentCount * minimumAllowedTicks) {
    throw new LongVideoPlanError(
      'DIGITAL_HUMAN_LONG_SEGMENTS_TOO_SHORT',
      '当前总时长无法拆成全部满足最短时长的分段。',
    );
  }

  const maxBoundaryDriftTicks = Math.max(
    0,
    Math.round((input.maxBoundaryDriftSeconds ?? 12) * TIME_PRECISION),
  );
  const boundaries = (input.boundaries ?? [])
    .filter((item) => Number.isFinite(item.atSeconds))
    .map((item) => ({
      ...item,
      atTicks: Math.round(item.atSeconds * TIME_PRECISION),
      confidence: Math.max(0, Math.min(1, Number(item.confidence ?? 1))),
    }))
    .filter((item) => item.atTicks > 0 && item.atTicks < totalTicks);

  const cuts: Array<{ atTicks: number; source: LongVideoSegment['endBoundary'] }> = [];
  let previousCutTicks = 0;

  for (let index = 1; index < segmentCount; index += 1) {
    const remainingSegments = segmentCount - index;
    const lowerCutTicks = Math.max(
      previousCutTicks + minimumAllowedTicks,
      totalTicks - remainingSegments * recommendedMaxTicks,
    );
    const upperCutTicks = Math.min(
      previousCutTicks + recommendedMaxTicks,
      totalTicks - remainingSegments * minimumAllowedTicks,
    );
    const balancedCutTicks = Math.round((totalTicks * index) / segmentCount);
    const idealCutTicks = Math.max(lowerCutTicks, Math.min(upperCutTicks, balancedCutTicks));

    const candidates = boundaries
      .filter((item) => item.atTicks >= lowerCutTicks && item.atTicks <= upperCutTicks)
      .filter((item) => Math.abs(item.atTicks - idealCutTicks) <= maxBoundaryDriftTicks)
      .sort((left, right) => {
        const distance = Math.abs(left.atTicks - idealCutTicks) - Math.abs(right.atTicks - idealCutTicks);
        if (distance !== 0) return distance;
        const priority = boundaryPriority(right.kind) - boundaryPriority(left.kind);
        if (priority !== 0) return priority;
        const confidence = right.confidence - left.confidence;
        if (confidence !== 0) return confidence;
        return right.atTicks - left.atTicks;
      });

    const chosen = candidates[0];
    const atTicks = chosen?.atTicks ?? idealCutTicks;
    cuts.push({ atTicks, source: chosen?.kind ?? 'planned' });
    previousCutTicks = atTicks;
  }

  cuts.push({ atTicks: totalTicks, source: 'media_end' });
  const segments: LongVideoSegment[] = [];
  let startTicks = 0;
  for (const [ordinal, cut] of cuts.entries()) {
    const durationTicks = cut.atTicks - startTicks;
    if (durationTicks < minimumAllowedTicks || durationTicks > recommendedMaxTicks || durationTicks >= hardMaxTicks) {
      throw new LongVideoPlanError(
        'DIGITAL_HUMAN_LONG_PLAN_INVARIANT',
        `第 ${ordinal + 1} 段不满足供应商时长约束。`,
      );
    }
    segments.push({
      ordinal,
      startSeconds: fromTicks(startTicks),
      endSeconds: fromTicks(cut.atTicks),
      durationSeconds: fromTicks(durationTicks),
      endBoundary: cut.source,
    });
    startTicks = cut.atTicks;
  }

  return {
    totalDurationSeconds: fromTicks(totalTicks),
    segmentCount: segments.length,
    recommendedMaxSegmentSeconds: fromTicks(recommendedMaxTicks),
    hardMaxExclusiveSeconds: fromTicks(hardMaxTicks),
    minExclusiveSeconds: fromTicks(minTicks),
    segments,
  };
}

/** Locks one parent quote. Child estimates are explanatory and never settle separately. */
export function quoteAliLongDigitalHumanVideo(plan: LongVideoPlan, unitPriceYuan: number): LongVideoQuote {
  if (!Number.isFinite(unitPriceYuan) || unitPriceYuan < 0) {
    throw new LongVideoPlanError('DIGITAL_HUMAN_LONG_PRICE_INVALID', '每秒售价必须是非负有限数值。');
  }
  const lockedTotalYuan = roundMoney(plan.totalDurationSeconds * unitPriceYuan);
  const segmentEstimates = plan.segments.map((segment) => ({
    ordinal: segment.ordinal,
    amountYuan: roundMoney(segment.durationSeconds * unitPriceYuan),
  }));
  const estimatedTotal = roundMoney(segmentEstimates.reduce((sum, item) => sum + item.amountYuan, 0));
  const roundingDifference = roundMoney(lockedTotalYuan - estimatedTotal);
  if (roundingDifference !== 0 && segmentEstimates.length > 0) {
    const last = segmentEstimates[segmentEstimates.length - 1];
    last.amountYuan = roundMoney(last.amountYuan + roundingDifference);
  }
  return {
    unitPriceYuan: roundUnitPrice(unitPriceYuan),
    billableSeconds: plan.totalDurationSeconds,
    lockedTotalYuan,
    segmentEstimates,
  };
}

/**
 * Enforces the parent billing boundary: no user charge before every child is
 * complete and one merged, owned asset exists; a completed parent has one
 * matching billing operation and exactly the locked charge.
 */
export function deriveLongVideoParentPhase(input: {
  childStates: LongVideoChildState[];
  mergedAssetId?: string | null;
  lockedPriceYuan: number;
  chargedYuan?: number;
  billingOperationId?: string | number | null;
}): LongVideoParentPhase {
  if (input.childStates.length === 0) {
    throw new LongVideoPlanError('DIGITAL_HUMAN_LONG_CHILDREN_EMPTY', '父任务至少需要一个子任务。');
  }
  const lockedPriceYuan = roundMoney(input.lockedPriceYuan);
  const chargedYuan = roundMoney(input.chargedYuan ?? 0);
  if (lockedPriceYuan < 0 || chargedYuan < 0) {
    throw new LongVideoPlanError('DIGITAL_HUMAN_LONG_BILLING_INVALID', '锁定报价和已扣金额不能为负数。');
  }

  const allCompleted = input.childStates.every((state) => state === 'completed');
  const hasMergedAsset = Boolean(String(input.mergedAssetId ?? '').trim());
  const hasBillingOperation = Boolean(String(input.billingOperationId ?? '').trim());
  if (chargedYuan > 0 && (!allCompleted || !hasMergedAsset)) {
    throw new LongVideoPlanError(
      'DIGITAL_HUMAN_LONG_EARLY_CHARGE',
      '子任务未全部完成或整片尚未交付时禁止扣除用户费用。',
    );
  }
  if (chargedYuan > 0 && (chargedYuan !== lockedPriceYuan || !hasBillingOperation)) {
    throw new LongVideoPlanError(
      'DIGITAL_HUMAN_LONG_CHARGE_MISMATCH',
      '已扣金额必须等于锁定报价，并绑定唯一计费操作。',
    );
  }
  if (input.childStates.includes('submission_unknown')) return 'confirming';
  if (input.childStates.includes('failed')) return 'failed';
  if (input.childStates.includes('cancelled')) return 'cancelled';
  if (!allCompleted) {
    return input.childStates.every((state) => state === 'queued') ? 'queued' : 'processing';
  }
  if (!hasMergedAsset) return 'merging';
  if (chargedYuan === 0 && lockedPriceYuan > 0) return 'ready_to_settle';
  if (lockedPriceYuan === 0 && chargedYuan === 0) return 'completed';
  return 'completed';
}
