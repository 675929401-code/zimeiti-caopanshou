export type AccountState = { is_active?: boolean | null; status?: string | null };

/** Account availability is separate from membership/payment status. */
export function isUserAccountDisabled(user: AccountState): boolean {
  return user.is_active === false || ['blocked', 'suspended', 'disabled', 'inactive'].includes((user.status || '').trim().toLowerCase());
}
