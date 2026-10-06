import { createHash } from 'node:crypto';

type Waiter = { start: () => void; timer: ReturnType<typeof setTimeout> };
type SlotPool = { active: number; waiters: Waiter[] };
const shared = globalThis as typeof globalThis & { __voiceProviderSlots?: Map<string, SlotPool> };
const pools = shared.__voiceProviderSlots ??= new Map<string, SlotPool>();

/** One Web process owns voice dispatch in the supported deployment topology.
 * Share slots across route bundles, both dialogue roles and preview synthesis.
 * This is not a distributed limiter; extra Web replicas require one first.
 */
export async function withVoiceProviderSlot<T>(credential: string, run: () => Promise<T>): Promise<T> {
  const key = createHash('sha256').update(credential).digest('hex');
  const pool = pools.get(key) ?? { active: 0, waiters: [] };
  pools.set(key, pool);
  const limit = 4;
  const grant = () => { pool.active++; };
  if (pool.active < limit && pool.waiters.length === 0) grant();
  else {
    if (pool.waiters.length >= 100) throw new Error('VOICE_PROVIDER_QUEUE_BUSY');
    await new Promise<void>((resolve, reject) => {
      const waiter: Waiter = {
        start: () => { clearTimeout(waiter.timer); grant(); resolve(); },
        timer: setTimeout(() => {
          const index = pool.waiters.indexOf(waiter);
          if (index >= 0) pool.waiters.splice(index, 1);
          reject(new Error('VOICE_PROVIDER_QUEUE_BUSY'));
        }, 90000),
      };
      pool.waiters.push(waiter);
    });
  }
  try { return await run(); }
  finally {
    pool.active--;
    while (pool.active < limit && pool.waiters.length) pool.waiters.shift()!.start();
    if (pool.active === 0 && pool.waiters.length === 0) pools.delete(key);
  }
}
