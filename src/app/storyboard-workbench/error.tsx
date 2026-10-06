"use client";

import { SecondaryRouteError } from "@/components/secondary-route-state";

export default function StoryboardWorkbenchError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return <SecondaryRouteError label="分镜工作台" reset={reset} />;
}
