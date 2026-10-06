'use client';

import { usePathname } from 'next/navigation';
import { useEffect, useRef, useState, ReactNode } from 'react';

/**
 * 路由切换过渡组件 — 防止智音工坊子页面切换时白屏闪烁
 *
 * 原理：
 * 1. 监听 pathname 变化
 * 2. 路由切换时给内容加淡出 → 短暂延迟 → 新内容淡入
 * 3. 使用 CSS opacity + transition 实现平滑过渡，无需额外动画库
 *
 * 关键：不做卸载/重挂载（那样反而更闪），而是让新内容直接替换后淡入
 */
export function RouteTransition({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const [opacity, setOpacity] = useState(1);
  const prevPathRef = useRef(pathname);
  const transitionRef = useRef(false);

  useEffect(() => {
    // 路由变化时触发淡入动画
    if (prevPathRef.current !== pathname) {
      prevPathRef.current = pathname;
      // 防止连续快速切换时动画叠加
      if (!transitionRef.current) {
        transitionRef.current = true;
        // 先淡出（极短暂，用户几乎感知不到，但避免了硬切）
        setOpacity(0.3);
        // 快速淡入
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            setOpacity(1);
            transitionRef.current = false;
          });
        });
      }
    }
  }, [pathname]);

  return (
    <div
      className="transition-opacity duration-150 ease-out"
      style={{ opacity }}
    >
      {children}
    </div>
  );
}
