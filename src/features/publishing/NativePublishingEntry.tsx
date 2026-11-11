"use client";

import { PublishingStudio } from "./studio/PublishingStudio";

/** Compatibility entry for callers that previously opened the native UI. */
export function NativePublishingEntry() {
  return <PublishingStudio />;
}
