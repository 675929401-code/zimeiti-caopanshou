import 'server-only';
import type { AuthUser, getSupabase } from '@/lib/api-middleware';
import { PublishingStudioBootstrapSchema } from '@/lib/publishing-studio-contract';
import { readPublishingBootstrap } from './publishing-service';

/** Runs behind the native cookie, owner and permission guards. No provider dispatch. */
export async function readPublishingStudioBootstrap(user: AuthUser, database: ReturnType<typeof getSupabase>) {
  return PublishingStudioBootstrapSchema.parse(await readPublishingBootstrap(user,database));
}
