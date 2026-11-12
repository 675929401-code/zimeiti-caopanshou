"use client";

import { useLayoutEffect, useRef, type ReactNode } from "react";
import styles from "./storyboard-editor-viewport.module.css";

/** Keep one mounted editor while its desktop canvas fits the available port. */
export function StoryboardEditorViewport({ enabled, children }: { enabled: boolean; children: ReactNode }) {
  const portRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const port = portRef.current;
    const canvas = canvasRef.current;
    if (!enabled || !port || !canvas) return;
    let frame = 0;
    const measure = () => {
      const width = port.clientWidth;
      const height = port.clientHeight;
      // History hides this subtree. Keep its last geometry until it is visible.
      if (!width || !height) return;
      const scale = Math.min(1, Math.max(0.75, width / 1440));
      canvas.style.setProperty("--storyboard-editor-scale", String(scale));
      canvas.style.setProperty("--storyboard-editor-width", `${width / scale}px`);
      canvas.style.setProperty("--storyboard-editor-height", `${height / scale}px`);
      canvas.dataset.scale = String(scale);
    };
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(measure);
    });
    measure();
    observer.observe(port);
    return () => { observer.disconnect(); cancelAnimationFrame(frame); };
  }, [enabled]);

  if (!enabled) return <>{children}</>;

  return (
    <div ref={portRef} className={styles.port} data-storyboard-viewport>
      <div ref={canvasRef} className={styles.canvas} data-storyboard-canvas>
        {children}
      </div>
    </div>
  );
}
