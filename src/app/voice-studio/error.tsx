"use client";

import { SecondaryRouteError } from "@/components/secondary-route-state";

export default function VoiceStudioError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return <SecondaryRouteError label="智音工坊" reset={reset} />;
}
