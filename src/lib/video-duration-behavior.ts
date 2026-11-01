/** Fixed public duration semantics; never accept administrator prose. */
export type VideoDurationBehavior = "requested_target";

export function readVideoDurationBehavior(value: unknown): VideoDurationBehavior | undefined {
  return value === "requested_target" ? value : undefined;
}
