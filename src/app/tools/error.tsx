"use client";

import { SecondaryRouteError } from "@/components/secondary-route-state";

export default function ToolsError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return <SecondaryRouteError label="工具箱" reset={reset} />;
}
