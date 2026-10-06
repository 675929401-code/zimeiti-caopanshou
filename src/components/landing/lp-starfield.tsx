"use client";

import { useEffect, useRef } from "react";

interface Star {
  x: number;      // 基础位置
  y: number;
  z: number;      // 深度 0.3~1（视差/吸引权重）
  r: number;      // 半径
  a: number;      // 基础透明度
  ph: number;     // 闪烁相位
  sp: number;     // 闪烁速度
  vx: number;     // 漂移速度
  vy: number;
  accent: boolean; // 是否为紫青色星星
}

interface Meteor {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  max: number;
}

interface Ripple {
  x: number;
  y: number;
  r: number;
  max: number;
  life: number;
}

interface Aurora {
  x: number;       // 中心 x（百分比 0~1）
  y: number;       // 中心 y（百分比 0~1）
  vx: number;      // 漂移速度
  vy: number;
  r: number;       // 半径（像素）
  hue: number;     // 颜色选择 0=紫 1=青
  phase: number;   // 脉动相位
}

/**
 * 鼠标跟随星尘背景（Landing 专用）v2
 * - 星星缓慢漂移 + 闪烁
 * - 鼠标移动产生深度视差
 * - 光标附近的星星被轻轻吸引
 * - 光标紫青光晕
 * - 星座连线（附近星星自动连线，形成动态网络）
 * - 极光带（背景流动渐变光团）
 * - 点击能量波纹
 * - 偶发流星（增强尾迹）
 * - prefers-reduced-motion 时静态渲染；标签页隐藏时暂停
 */
export function LpStarfield({ dark }: { dark: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const darkRef = useRef(dark);
  darkRef.current = dark;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let w = 0;
    let h = 0;
    let stars: Star[] = [];
    let meteors: Meteor[] = [];
    let ripples: Ripple[] = [];
    let auroras: Aurora[] = [];
    let raf = 0;
    let running = true;
    let lastMeteorAt = 0;
    const mouse = { x: 0, y: 0, sx: 0, sy: 0, has: false, aura: 0 };
    const par = { x: 0, y: 0 };

    const buildStars = () => {
      const count = Math.max(60, Math.min(140, Math.floor((w * h) / 11000)));
      stars = [];
      for (let i = 0; i < count; i++) {
        stars.push({
          x: Math.random() * w,
          y: Math.random() * h,
          z: 0.3 + Math.random() * 0.7,
          r: 0.6 + Math.random() * 1.5,
          a: 0.35 + Math.random() * 0.5,
          ph: Math.random() * Math.PI * 2,
          sp: 0.5 + Math.random() * 1.4,
          vx: (Math.random() - 0.5) * 0.07,
          vy: (Math.random() - 0.5) * 0.05,
          accent: Math.random() < 0.45,
        });
      }
    };

    const buildAuroras = () => {
      auroras = [
        { x: 0.2, y: 0.3, vx: 0.00012, vy: 0.00008, r: Math.max(w, h) * 0.35, hue: 0, phase: 0 },
        { x: 0.75, y: 0.6, vx: -0.00010, vy: 0.00012, r: Math.max(w, h) * 0.3, hue: 1, phase: Math.PI },
        { x: 0.5, y: 0.15, vx: 0.00008, vy: -0.00010, r: Math.max(w, h) * 0.25, hue: 0, phase: Math.PI * 0.5 },
      ];
    };

    const starColor = (s: Star, alpha: number) => {
      if (darkRef.current) {
        return s.accent ? `rgba(124, 92, 255, ${alpha})` : `rgba(105, 231, 255, ${alpha * 0.8})`;
      }
      return s.accent ? `rgba(109, 40, 217, ${alpha})` : `rgba(124, 92, 255, ${alpha * 0.75})`;
    };

    const drawAuroras = (t: number) => {
      for (const au of auroras) {
        au.x += au.vx;
        au.y += au.vy;
        if (au.x < -0.2) au.x = 1.2;
        if (au.x > 1.2) au.x = -0.2;
        if (au.y < -0.2) au.y = 1.2;
        if (au.y > 1.2) au.y = -0.2;

        const pulse = 0.85 + 0.15 * Math.sin(t * 0.0004 + au.phase);
        const cx = au.x * w;
        const cy = au.y * h;
        const cr = au.r * pulse;
        const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, cr);
        if (darkRef.current) {
          if (au.hue === 0) {
            g.addColorStop(0, "rgba(124, 92, 255, 0.08)");
            g.addColorStop(0.4, "rgba(124, 92, 255, 0.03)");
            g.addColorStop(1, "rgba(124, 92, 255, 0)");
          } else {
            g.addColorStop(0, "rgba(105, 231, 255, 0.06)");
            g.addColorStop(0.4, "rgba(105, 231, 255, 0.02)");
            g.addColorStop(1, "rgba(105, 231, 255, 0)");
          }
        } else {
          if (au.hue === 0) {
            g.addColorStop(0, "rgba(109, 40, 217, 0.05)");
            g.addColorStop(0.4, "rgba(109, 40, 217, 0.02)");
            g.addColorStop(1, "rgba(109, 40, 217, 0)");
          } else {
            g.addColorStop(0, "rgba(124, 92, 255, 0.04)");
            g.addColorStop(0.4, "rgba(124, 92, 255, 0.015)");
            g.addColorStop(1, "rgba(124, 92, 255, 0)");
          }
        }
        ctx.fillStyle = g;
        ctx.fillRect(cx - cr, cy - cr, cr * 2, cr * 2);
      }
    };

    const drawConstellations = (positions: { x: number; y: number; a: number }[]) => {
      const maxDist = 130;
      const maxDistSq = maxDist * maxDist;
      const accent = darkRef.current ? "124, 92, 255" : "109, 40, 217";
      const accent2 = "105, 231, 255";
      for (let i = 0; i < positions.length; i++) {
        for (let j = i + 1; j < positions.length; j++) {
          const dx = positions[i].x - positions[j].x;
          const dy = positions[i].y - positions[j].y;
          const dSq = dx * dx + dy * dy;
          if (dSq < maxDistSq) {
            const d = Math.sqrt(dSq);
            const alpha = (1 - d / maxDist) * 0.15 * Math.min(positions[i].a, positions[j].a) * 2;
            if (alpha < 0.01) continue;
            // 交替使用紫色和青色线条
            const useCyan = (i + j) % 3 === 0;
            ctx.strokeStyle = useCyan ? `rgba(${accent2}, ${alpha * 0.7})` : `rgba(${accent}, ${alpha})`;
            ctx.lineWidth = 0.5;
            ctx.beginPath();
            ctx.moveTo(positions[i].x, positions[i].y);
            ctx.lineTo(positions[j].x, positions[j].y);
            ctx.stroke();
          }
        }
      }
    };

    const drawRipples = () => {
      ripples = ripples.filter((r) => r.life < r.max);
      for (const r of ripples) {
        r.life += 1;
        r.r = (r.life / r.max) * r.max;
        const fade = 1 - r.life / r.max;
        const accent = darkRef.current ? "124, 92, 255" : "109, 40, 217";
        const accent2 = "105, 231, 255";
        // 外圈
        ctx.strokeStyle = `rgba(${accent}, ${0.5 * fade})`;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(r.x, r.y, r.r, 0, Math.PI * 2);
        ctx.stroke();
        // 内圈（青色，稍滞后）
        if (r.r > 15) {
          ctx.strokeStyle = `rgba(${accent2}, ${0.3 * fade})`;
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.arc(r.x, r.y, r.r - 12, 0, Math.PI * 2);
          ctx.stroke();
        }
      }
    };

    const drawFrame = (t: number, staticOnly: boolean) => {
      ctx.clearRect(0, 0, w, h);

      // 1. 极光带（最底层背景）
      if (!staticOnly) drawAuroras(t);

      // 平滑鼠标位置与光晕强度
      if (mouse.has) {
        mouse.sx += (mouse.x - mouse.sx) * 0.08;
        mouse.sy += (mouse.y - mouse.sy) * 0.08;
      }
      mouse.aura += ((mouse.has ? 1 : 0) - mouse.aura) * 0.08;

      // 平滑视差目标
      const tpx = (mouse.sx - w / 2) * mouse.aura;
      const tpy = (mouse.sy - h / 2) * mouse.aura;
      par.x += (tpx - par.x) * 0.06;
      par.y += (tpy - par.y) * 0.06;

      // 2. 光标紫青光晕
      if (mouse.aura > 0.01) {
        const g = ctx.createRadialGradient(mouse.sx, mouse.sy, 0, mouse.sx, mouse.sy, 200);
        const base = darkRef.current ? 0.14 : 0.08;
        g.addColorStop(0, `rgba(124, 92, 255, ${base * mouse.aura})`);
        g.addColorStop(0.4, `rgba(105, 231, 255, ${base * 0.6 * mouse.aura})`);
        g.addColorStop(1, "rgba(124, 92, 255, 0)");
        ctx.fillStyle = g;
        ctx.fillRect(mouse.sx - 200, mouse.sy - 200, 400, 400);
      }

      // 3. 星星 + 收集渲染位置（用于连线）
      const positions: { x: number; y: number; a: number }[] = [];
      for (const s of stars) {
        if (!staticOnly) {
          s.x += s.vx;
          s.y += s.vy;
          if (s.x < -10) s.x = w + 10;
          else if (s.x > w + 10) s.x = -10;
          if (s.y < -10) s.y = h + 10;
          else if (s.y > h + 10) s.y = -10;
        }
        let rx = s.x + par.x * 0.035 * s.z;
        let ry = s.y + par.y * 0.035 * s.z;
        if (mouse.aura > 0.01) {
          const dx = mouse.sx - rx;
          const dy = mouse.sy - ry;
          const d = Math.hypot(dx, dy);
          if (d < 220 && d > 0.001) {
            const pull = (1 - d / 220) * 16 * s.z * mouse.aura;
            rx += (dx / d) * pull;
            ry += (dy / d) * pull;
          }
        }
        const tw = staticOnly ? 0.8 : 0.6 + 0.4 * Math.sin(t * 0.001 * s.sp + s.ph);
        const alpha = s.a * tw;
        ctx.beginPath();
        ctx.arc(rx, ry, s.r * (0.8 + 0.4 * s.z), 0, Math.PI * 2);
        ctx.fillStyle = starColor(s, alpha);
        ctx.fill();
        if (s.r > 1.5) {
          ctx.beginPath();
          ctx.arc(rx, ry, s.r * 3, 0, Math.PI * 2);
          ctx.fillStyle = starColor(s, alpha * 0.12);
          ctx.fill();
        }
        positions.push({ x: rx, y: ry, a: alpha });
      }

      // 4. 星座连线
      drawConstellations(positions);

      // 5. 点击能量波纹
      if (!staticOnly) drawRipples();

      // 6. 偶发流星（增强版：更频繁、尾迹更长）
      if (!staticOnly) {
        if (t - lastMeteorAt > 4000 + Math.random() * 3500 && meteors.length < 3) {
          lastMeteorAt = t;
          const fromLeft = Math.random() < 0.5;
          meteors.push({
            x: fromLeft ? -60 : Math.random() * w * 0.5 + w * 0.5,
            y: Math.random() * h * 0.35,
            vx: fromLeft ? 8 + Math.random() * 4 : -(8 + Math.random() * 4),
            vy: 2.5 + Math.random() * 1.5,
            life: 0,
            max: 100 + Math.random() * 50,
          });
        }
        meteors = meteors.filter((m) => m.life < m.max);
        for (const m of meteors) {
          m.life += 1;
          m.x += m.vx;
          m.y += m.vy;
          const fade = 1 - m.life / m.max;
          const trailLen = 14;
          const tx = m.x - m.vx * trailLen;
          const ty = m.y - m.vy * trailLen;
          const grad = ctx.createLinearGradient(m.x, m.y, tx, ty);
          const col = darkRef.current ? "124, 92, 255" : "109, 40, 217";
          grad.addColorStop(0, `rgba(255, 255, 255, ${0.9 * fade})`);
          grad.addColorStop(0.15, `rgba(${col}, ${0.8 * fade})`);
          grad.addColorStop(0.5, `rgba(105, 231, 255, ${0.4 * fade})`);
          grad.addColorStop(1, `rgba(${col}, 0)`);
          ctx.strokeStyle = grad;
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.moveTo(m.x, m.y);
          ctx.lineTo(tx, ty);
          ctx.stroke();
          // 流星头部光点
          ctx.beginPath();
          ctx.arc(m.x, m.y, 2, 0, Math.PI * 2);
          ctx.fillStyle = `rgba(255, 255, 255, ${0.9 * fade})`;
          ctx.fill();
          ctx.beginPath();
          ctx.arc(m.x, m.y, 5, 0, Math.PI * 2);
          ctx.fillStyle = `rgba(${col}, ${0.3 * fade})`;
          ctx.fill();
        }
      }
    };

    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      w = window.innerWidth;
      h = window.innerHeight;
      canvas.width = Math.floor(w * dpr);
      canvas.height = Math.floor(h * dpr);
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      mouse.sx = w / 2;
      mouse.sy = h / 2;
      buildStars();
      buildAuroras();
      if (reduced) drawFrame(0, true);
    };

    const loop = (t: number) => {
      if (!running) return;
      drawFrame(t, false);
      raf = requestAnimationFrame(loop);
    };

    const onMove = (e: PointerEvent) => {
      if (!mouse.has) {
        mouse.sx = e.clientX;
        mouse.sy = e.clientY;
      }
      mouse.x = e.clientX;
      mouse.y = e.clientY;
      mouse.has = true;
    };
    const onOut = (e: PointerEvent) => {
      if (!e.relatedTarget) mouse.has = false;
    };
    const onClick = (e: MouseEvent) => {
      if (reduced) return;
      ripples.push({
        x: e.clientX,
        y: e.clientY,
        r: 0,
        max: 180,
        life: 0,
      });
    };
    const onVis = () => {
      if (document.hidden) {
        running = false;
        cancelAnimationFrame(raf);
      } else if (!reduced) {
        running = true;
        raf = requestAnimationFrame(loop);
      }
    };

    resize();
    window.addEventListener("resize", resize);
    window.addEventListener("pointermove", onMove, { passive: true });
    window.addEventListener("click", onClick, { passive: true });
    document.addEventListener("pointerout", onOut);
    document.addEventListener("visibilitychange", onVis);
    if (!reduced) raf = requestAnimationFrame(loop);

    return () => {
      running = false;
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", resize);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("click", onClick);
      document.removeEventListener("pointerout", onOut);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, []);

  return <canvas ref={canvasRef} className="absolute inset-0 h-full w-full" aria-hidden="true" />;
}
