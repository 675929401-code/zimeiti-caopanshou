"use client";

import { SecondaryRouteError } from "@/components/secondary-route-state";

export default function ImageWorkbenchError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return <SecondaryRouteError label="AI生图工作台" reset={reset} />;
}
