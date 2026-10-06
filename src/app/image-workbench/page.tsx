"use client";

import dynamic from "next/dynamic";

// Drafts and unresolved requests live in browser storage. Restore them on the
// client instead of hydrating different server and browser card collections.
const ImageWorkbench = dynamic(
  () => import("@/components/image-workbench").then((module) => module.ImageWorkbench),
  {
    ssr: false,
    loading: () => (
      <div className="flex min-h-screen items-center justify-center text-sm text-muted-foreground" role="status" aria-live="polite">
        正在打开生图工作台...
      </div>
    ),
  },
);

export default function ImageWorkbenchPage() {
  return <ImageWorkbench />;
}
