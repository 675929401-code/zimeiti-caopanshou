"use client";

import { usePathname } from "next/navigation";
import { useEffect } from "react";
import { markSecondaryPageReturn } from "@/lib/marketplace-navigation";

export function SecondaryPageReturnGuard() {
  const pathname = usePathname();

  useEffect(() => {
    if (pathname !== "/") markSecondaryPageReturn();
  }, [pathname]);

  return null;
}
