import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  deriveLongVideoParentPhase,
  LongVideoPlanError,
  planAliLongDigitalHumanVideo,
  quoteAliLongDigitalHumanVideo,
} from '../src/features/digital-human/long-video-segmentation';

function sum(values: number[]) {
  return Number(values.reduce((total, value) => total + value, 0).toFixed(3));
}

const single = planAliLongDigitalHumanVideo({ totalDurationSeconds: 119.999 });
assert.equal(single.segmentCount, 2, 'recommended 115-second ceiling must apply before the provider hard limit');
assert.deepEqual(single.segments.map((item) => item.durationSeconds), [60, 59.999]);

const balanced = planAliLongDigitalHumanVideo({ totalDurationSeconds: 150 });
assert.deepEqual(balanced.segments.map((item) => item.durationSeconds), [75, 75]);
assert.equal(quoteAliLongDigitalHumanVideo(balanced, 0.08).lockedTotalYuan, 12);

const natural = planAliLongDigitalHumanVideo({
  totalDurationSeconds: 150,
  boundaries: [
    { atSeconds: 73.2, kind: 'sentence' },
    { atSeconds: 74.5, kind: 'silence', confidence: 0.94 },
    { atSeconds: 90, kind: 'manual' },
  ],
});
assert.deepEqual(natural.segments.map((item) => item.durationSeconds), [74.5, 75.5]);
assert.equal(natural.segments[0].endBoundary, 'silence');

const manual = planAliLongDigitalHumanVideo({
  totalDurationSeconds: 150,
  boundaries: [
    { atSeconds: 74.5, kind: 'sentence' },
    { atSeconds: 74.5, kind: 'manual' },
  ],
});
assert.equal(manual.segments[0].endBoundary, 'manual', 'manual marker wins an equal-distance tie');

const oddTail = planAliLongDigitalHumanVideo({ totalDurationSeconds: 116 });
assert.deepEqual(oddTail.segments.map((item) => item.durationSeconds), [58, 58]);

const threeParts = planAliLongDigitalHumanVideo({ totalDurationSeconds: 235.001 });
assert.equal(threeParts.segmentCount, 3);
assert.equal(sum(threeParts.segments.map((item) => item.durationSeconds)), 235.001);
assert.ok(threeParts.segments.every((item) => item.durationSeconds > 2 && item.durationSeconds <= 115));
assert.ok(threeParts.segments.every((item) => item.durationSeconds < 120));

assert.throws(
  () => planAliLongDigitalHumanVideo({ totalDurationSeconds: 2 }),
  (error: unknown) => error instanceof LongVideoPlanError && error.code === 'DIGITAL_HUMAN_LONG_DURATION_TOO_SHORT',
);
assert.throws(
  () => planAliLongDigitalHumanVideo({ totalDurationSeconds: 150, recommendedMaxSegmentSeconds: 120 }),
  (error: unknown) => error instanceof LongVideoPlanError && error.code === 'DIGITAL_HUMAN_LONG_SEGMENT_LIMIT_INVALID',
);

assert.equal(deriveLongVideoParentPhase({ childStates: ['queued', 'queued'], lockedPriceYuan: 12 }), 'queued');
assert.equal(deriveLongVideoParentPhase({ childStates: ['completed', 'running'], lockedPriceYuan: 12 }), 'processing');
assert.equal(deriveLongVideoParentPhase({ childStates: ['completed', 'submission_unknown'], lockedPriceYuan: 12 }), 'confirming');
assert.equal(deriveLongVideoParentPhase({ childStates: ['completed', 'completed'], lockedPriceYuan: 12 }), 'merging');
assert.equal(deriveLongVideoParentPhase({ childStates: ['completed', 'completed'], mergedAssetId: 'owned-result', lockedPriceYuan: 12 }), 'ready_to_settle');
assert.equal(deriveLongVideoParentPhase({
  childStates: ['completed', 'completed'], mergedAssetId: 'owned-result', lockedPriceYuan: 12,
  chargedYuan: 12, billingOperationId: 101,
}), 'completed');
assert.throws(
  () => deriveLongVideoParentPhase({ childStates: ['completed', 'running'], lockedPriceYuan: 12, chargedYuan: 6 }),
  (error: unknown) => error instanceof LongVideoPlanError && error.code === 'DIGITAL_HUMAN_LONG_EARLY_CHARGE',
);
assert.throws(
  () => deriveLongVideoParentPhase({
    childStates: ['completed', 'completed'], mergedAssetId: 'owned-result', lockedPriceYuan: 12,
    chargedYuan: 11.99, billingOperationId: 102,
  }),
  (error: unknown) => error instanceof LongVideoPlanError && error.code === 'DIGITAL_HUMAN_LONG_CHARGE_MISMATCH',
);

const migration = readFileSync(
  new URL('../supabase/migrations/20260904013000_digital_human_long_video_jobs.sql', import.meta.url),
  'utf8',
);
assert.match(migration, /UNIQUE \(user_id, client_request_id\)/u);
assert.match(migration, /UNIQUE \(parent_id, ordinal\)/u);
assert.match(migration, /charged_yuan = locked_price_yuan/u);
assert.match(migration, /merged_asset_id IS NOT NULL/u);
assert.match(migration, /VIDEO_REQUEST_IDEMPOTENCY_CONFLICT/u);
assert.doesNotMatch(migration, /cash_transactions|UPDATE\s+public\.users/iu, 'foundation migration must not debit wallets');

console.log('PASS: long-video planning, natural boundaries, no micro-tail, parent state and exactly-once billing boundary');
