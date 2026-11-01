import { getSupabaseAdminClient } from "@/storage/database/supabase-client";
import { PlatformConfigurationError } from "./platform-configuration-admin";
import { normalizeCredentialMetadata } from "./platform-configuration-pending-credentials";

/** Public admin status intentionally omits refs, revisions, fingerprints and secrets. */
export async function modelPoolCredentialStatus(releaseId: string) {
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu.test(releaseId)) {
    throw new PlatformConfigurationError("PLATFORM_CONFIGURATION_ID_INVALID", "候选编号无效");
  }
  const database = getSupabaseAdminClient();
  const release = await database.from("model_pool_config_releases").select("id").eq("id", releaseId).maybeSingle();
  if (release.error) throw new PlatformConfigurationError("PLATFORM_CONFIGURATION_READ_FAILED", "无法读取模型池版本");
  if (!release.data) throw new PlatformConfigurationError("PLATFORM_CONFIGURATION_RELEASE_NOT_FOUND", "模型池版本不存在");
  const result = await database.rpc("read_platform_model_pending_credential_metadata", { p_release_id: releaseId });
  if (result.error) throw new PlatformConfigurationError("PLATFORM_CONFIGURATION_READ_FAILED", "无法读取凭据变更状态");
  return normalizeCredentialMetadata(result.data).map(({ modelKey, expectedExists, state }) => ({ modelKey, expectedExists, state }));
}
