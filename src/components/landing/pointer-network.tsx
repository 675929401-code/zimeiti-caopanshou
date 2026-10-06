"use client";

import { useEffect, useRef } from "react";

type NetworkPoint = {
  x: number;
  y: number;
  homeX: number;
  homeY: number;
  vx: number;
  vy: number;
  radius: number;
  phase: number;
};

type PointerState = {
  x: number;
  y: number;
  active: boolean;
};

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

function seededUnit(seed: number) {
  const value = Math.sin(seed * 12.9898 + 78.233) * 43758.5453;
  return value - Math.floor(value);
}

function createPoints(width: number, height: number): NetworkPoint[] {
  const count = clamp(Math.round((width * height) / 28_000), 42, 76);
  const columns = Math.ceil(Math.sqrt((count * width) / Math.max(height, 1)));
  const rows = Math.ceil(count / columns);
  const cellWidth = width / columns;
  const cellHeight = height / rows;

  return Array.from({ length: count }, (_, index) => {
    const column = index % columns;
    const row = Math.floor(index / columns);
    const jitterX = (seededUnit(index + 1) - 0.5) * cellWidth * 0.64;
    const jitterY = (seededUnit(index + 101) - 0.5) * cellHeight * 0.64;
    const x = clamp((column + 0.5) * cellWidth + jitterX, 12, width - 12);
    const y = clamp((row + 0.5) * cellHeight + jitterY, 12, height - 12);

    return {
      x,
      y,
      homeX: x,
      homeY: y,
      vx: (seededUnit(index + 201) - 0.5) * 0.18,
      vy: (seededUnit(index + 301) - 0.5) * 0.18,
      radius: 0.8 + seededUnit(index + 401) * 1.25,
      phase: seededUnit(index + 501) * Math.PI * 2,
    };
  });
}

export function PointerNetwork() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const home = canvas?.closest<HTMLElement>(".soft-white-home");
    if (!canvas || !home) return;

    const context = canvas.getContext("2d", { alpha: true });
    if (!context) return;

    const root = document.documentElement;
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    const finePointer = window.matchMedia("(pointer: fine)");
    const pointer: PointerState = {
      x: window.innerWidth * 0.5,
      y: window.innerHeight * 0.34,
      active: false,
    };

    let width = Math.max(window.innerWidth, 1);
    let height = Math.max(window.innerHeight, 1);
    let points = createPoints(width, height);
    let frame = 0;
    let previousTime = performance.now();
    let accent = "#62f4e8";
    let accentTwo = "#70a2ff";
    let accentThree = "#f0bd58";

    const syncColors = () => {
      const style = getComputedStyle(home);
      accent = style.getPropertyValue("--oh-accent").trim() || accent;
      accentTwo = style.getPropertyValue("--oh-accent-two").trim() || accentTwo;
      accentThree = style.getPropertyValue("--oh-accent-three").trim() || accentThree;
    };

    const resize = () => {
      width = Math.max(window.innerWidth, 1);
      height = Math.max(window.innerHeight, 1);
      const pixelRatio = Math.min(window.devicePixelRatio || 1, 1.5);
      canvas.width = Math.round(width * pixelRatio);
      canvas.height = Math.round(height * pixelRatio);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
      points = createPoints(width, height);
      syncColors();
    };

    const draw = (time: number, animate: boolean) => {
      const elapsed = Math.min(2.2, Math.max(0.25, (time - previousTime) / 16.67));
      previousTime = time;
      context.clearRect(0, 0, width, height);

      for (const point of points) {
        if (animate) {
          const driftX = Math.cos(time * 0.00016 + point.phase) * 17;
          const driftY = Math.sin(time * 0.00013 + point.phase * 1.4) * 13;
          const targetX = point.homeX + driftX;
          const targetY = point.homeY + driftY;
          point.vx += (targetX - point.x) * 0.00075 * elapsed;
          point.vy += (targetY - point.y) * 0.00075 * elapsed;

          if (pointer.active) {
            const dx = pointer.x - point.x;
            const dy = pointer.y - point.y;
            const distance = Math.hypot(dx, dy);
            const influence = clamp(1 - distance / 290, 0, 1);
            if (influence > 0) {
              point.vx += dx * influence * 0.0018 * elapsed;
              point.vy += dy * influence * 0.0018 * elapsed;
            }
          }

          point.vx *= Math.pow(0.965, elapsed);
          point.vy *= Math.pow(0.965, elapsed);
          point.x += point.vx * elapsed;
          point.y += point.vy * elapsed;
        }
      }

      const connectionDistance = pointer.active ? 158 : 136;
      for (let leftIndex = 0; leftIndex < points.length; leftIndex += 1) {
        const left = points[leftIndex];
        for (let rightIndex = leftIndex + 1; rightIndex < points.length; rightIndex += 1) {
          const right = points[rightIndex];
          const dx = right.x - left.x;
          const dy = right.y - left.y;
          const distance = Math.hypot(dx, dy);
          if (distance > connectionDistance) continue;

          const midpointX = (left.x + right.x) * 0.5;
          const midpointY = (left.y + right.y) * 0.5;
          const pointerDistance = Math.hypot(pointer.x - midpointX, pointer.y - midpointY);
          const pointerBoost = pointer.active ? clamp(1 - pointerDistance / 330, 0, 1) : 0;
          context.globalAlpha = (1 - distance / connectionDistance) * (0.17 + pointerBoost * 0.42);
          context.strokeStyle = pointerBoost > 0.26 ? accentTwo : accent;
          context.lineWidth = 0.65 + pointerBoost * 0.7;
          context.beginPath();
          context.moveTo(left.x, left.y);
          context.lineTo(right.x, right.y);
          context.stroke();
        }
      }

      if (pointer.active) {
        for (const point of points) {
          const distance = Math.hypot(pointer.x - point.x, pointer.y - point.y);
          if (distance > 218) continue;
          context.globalAlpha = (1 - distance / 218) * 0.44;
          context.strokeStyle = accentThree;
          context.lineWidth = 0.72;
          context.beginPath();
          context.moveTo(point.x, point.y);
          context.lineTo(pointer.x, pointer.y);
          context.stroke();
        }
      }

      for (const point of points) {
        const pointerDistance = pointer.active ? Math.hypot(pointer.x - point.x, pointer.y - point.y) : Infinity;
        const pointerBoost = clamp(1 - pointerDistance / 260, 0, 1);
        context.globalAlpha = 0.48 + pointerBoost * 0.46;
        context.fillStyle = pointerBoost > 0.32 ? accentThree : accent;
        context.beginPath();
        context.arc(point.x, point.y, point.radius + pointerBoost * 1.15, 0, Math.PI * 2);
        context.fill();
      }

      context.globalAlpha = 1;
    };

    const animate = (time: number) => {
      draw(time, true);
      frame = window.requestAnimationFrame(animate);
    };

    const stop = () => {
      if (frame) window.cancelAnimationFrame(frame);
      frame = 0;
    };

    const syncMotion = () => {
      stop();
      pointer.active = false;
      delete canvas.dataset.networkPointer;
      if (reducedMotion.matches) {
        canvas.dataset.networkState = "static";
        draw(performance.now(), false);
        return;
      }
      canvas.dataset.networkState = "animated";
      previousTime = performance.now();
      frame = window.requestAnimationFrame(animate);
    };

    const handlePointerMove = (event: PointerEvent) => {
      if (!finePointer.matches || reducedMotion.matches) return;
      pointer.x = event.clientX;
      pointer.y = event.clientY;
      pointer.active = true;
      canvas.dataset.networkPointer = "active";
    };

    const handlePointerLeave = () => {
      pointer.active = false;
      delete canvas.dataset.networkPointer;
    };

    const handlePointerCapabilityChange = () => {
      if (finePointer.matches) return;
      pointer.active = false;
      delete canvas.dataset.networkPointer;
    };

    const handleVisibility = () => {
      if (document.hidden) stop();
      else syncMotion();
    };

    const themeObserver = new MutationObserver(() => {
      syncColors();
      if (reducedMotion.matches) draw(performance.now(), false);
    });

    resize();
    syncMotion();
    home.addEventListener("pointermove", handlePointerMove, { passive: true });
    home.addEventListener("pointerleave", handlePointerLeave);
    window.addEventListener("resize", resize, { passive: true });
    document.addEventListener("visibilitychange", handleVisibility);
    reducedMotion.addEventListener("change", syncMotion);
    finePointer.addEventListener("change", handlePointerCapabilityChange);
    themeObserver.observe(root, { attributes: true, attributeFilter: ["data-theme", "data-mode"] });

    return () => {
      stop();
      themeObserver.disconnect();
      home.removeEventListener("pointermove", handlePointerMove);
      home.removeEventListener("pointerleave", handlePointerLeave);
      window.removeEventListener("resize", resize);
      document.removeEventListener("visibilitychange", handleVisibility);
      reducedMotion.removeEventListener("change", syncMotion);
      finePointer.removeEventListener("change", handlePointerCapabilityChange);
    };
  }, []);

  return <canvas ref={canvasRef} className="swh-pointer-network" data-testid="swh-pointer-network" />;
}
