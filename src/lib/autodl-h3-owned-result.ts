import { getSupabaseAdminClient } from "@/storage/database/supabase-client";

/** Input must be the task already authorized by the calling playback route. */
export async function resolveOwnedAutodlH3VideoResultJobId(task: {
  id: unknown; user_id: unknown; model_id: unknown; task_id_external: unknown;
}) {
  const external = String(task.task_id_external || "");
  if (!task.id || !task.user_id || !task.model_id) throw new Error("H3_RESULT_JOB_BINDING_MISSING");
  if (/^h3_[a-f0-9]+$/u.test(external)) return external;
  if (!/^h3q_[a-f0-9]{40}$/u.test(external) || !task.id || !task.user_id || !task.model_id) throw new Error("H3_RESULT_JOB_BINDING_MISSING");
  const { data, error } = await getSupabaseAdminClient().from("autodl_h3_jobs")
    .select("upstream_task_id").eq("video_task_internal_id", task.id).eq("user_id", task.user_id)
    .eq("public_task_id", external).eq("model_id", task.model_id).maybeSingle();
  if (error || !/^h3_[a-f0-9]+$/u.test(String(data?.upstream_task_id || ""))) throw new Error("H3_RESULT_JOB_BINDING_UNAVAILABLE");
  return String(data.upstream_task_id);
}
