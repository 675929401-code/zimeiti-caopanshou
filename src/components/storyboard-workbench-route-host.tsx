"use client";
import { useLayoutEffect, useRef } from "react";
import { usePathname } from "next/navigation";
import { StoryboardWorkbench } from "./storyboard-workbench";
/** The layout retains this owner across history navigation, including live polls. */
export function StoryboardWorkbenchRouteHost() {
  const pathname = usePathname();
  const historyPage = pathname === "/storyboard-workbench/history";
  const visible = pathname === "/storyboard-workbench" || historyPage;
  const root = useRef<HTMLDivElement>(null);
  const positions = useRef(new Map<string, number>());
  useLayoutEffect(() => {
    const scroller = root.current?.closest("main");
    const savedPositions = positions.current;
    const top = savedPositions.get(pathname) || 0;
    const frame = requestAnimationFrame(() => {
      if (scroller) scroller.scrollTop = top;
      else window.scrollTo({ top });
    });
    return () => {
      cancelAnimationFrame(frame);
      savedPositions.set(pathname, scroller ? scroller.scrollTop : window.scrollY);
    };
  }, [pathname]);
  return <div ref={root} hidden={!visible}>{visible && <StoryboardWorkbench historyPage={historyPage} compactEditor />}</div>;
}
