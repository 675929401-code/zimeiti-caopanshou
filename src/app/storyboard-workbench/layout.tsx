import { Suspense, type ReactNode } from "react";
import { StoryboardWorkbenchRouteHost } from "@/components/storyboard-workbench-route-host";
import "./storyboard-workbench.css";
import "./storyboard-history-page.css";
export default function StoryboardWorkbenchLayout({ children }: { children: ReactNode }) {
  return <><Suspense fallback={<p>正在加载工作台…</p>}><StoryboardWorkbenchRouteHost /></Suspense>{children}</>;
}
