export const ADMIN_STEP_UP_DURATION_MINUTES = [10, 20] as const;

export const ADMIN_STEP_UP_RATE_LIMIT = {
  routeKey: "admin-step-up-unlock",
  windowSeconds: 15 * 60,
  attemptLimit: 5,
} as const;

export type AdminStepUpDurationMinutes = typeof ADMIN_STEP_UP_DURATION_MINUTES[number];

export function normalizeAdminStepUpDurationMinutes(value: unknown): AdminStepUpDurationMinutes {
  const parsed = Number(value);
  return ADMIN_STEP_UP_DURATION_MINUTES.includes(parsed as AdminStepUpDurationMinutes)
    ? parsed as AdminStepUpDurationMinutes
    : 10;
}
