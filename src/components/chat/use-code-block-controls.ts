"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, type RefObject } from "react";

/** Local reading state only; never changes the received code or saved message. */
export function useCodeBlockControls(layerRef: RefObject<HTMLDivElement | null>, enabled: boolean, messageKey: string) {
  const expanded = useRef(new Set<number>());
  const overflowing = useRef(new Set<number>());
  const collapsedScroll = useRef(new Map<number, number>());

  const prepareTarget = useCallback((target: HTMLElement) => {
    target.querySelectorAll<HTMLElement>(".code-block-wrapper").forEach((wrapper, index) => {
      const isExpanded = expanded.current.has(index);
      wrapper.classList.toggle("is-expanded", isExpanded);
      wrapper.classList.toggle("is-overflowing", overflowing.current.has(index));
      const button = wrapper.querySelector<HTMLButtonElement>(".code-block-expand-button");
      if (button) {
        button.setAttribute("aria-expanded", String(isExpanded));
        button.textContent = isExpanded ? "收起全文" : "展开全文";
      }
    });
  }, []);

  useLayoutEffect(() => {
    expanded.current.clear();
    overflowing.current.clear();
    collapsedScroll.current.clear();
  }, [messageKey]);

  useEffect(() => {
    const layer = layerRef.current;
    if (!enabled || !layer) return;
    let frame: number | null = null;
    const observed = new WeakSet<Element>();
    const schedule = () => {
      if (frame === null) frame = window.requestAnimationFrame(refresh);
    };
    const resize = new ResizeObserver(schedule);
    const refresh = () => {
      frame = null;
      layer.querySelectorAll<HTMLElement>(".code-block-wrapper").forEach((wrapper, index) => {
        const pre = wrapper.querySelector<HTMLElement>(".code-block-pre");
        const button = wrapper.querySelector<HTMLButtonElement>(".code-block-expand-button");
        if (!pre || !button) return;
        if (!observed.has(pre)) { observed.add(pre); resize.observe(pre); }
        const isExpanded = expanded.current.has(index);
        const tier = parseFloat(getComputedStyle(pre).getPropertyValue("--code-block-viewport")) || 240;
        const ceiling = Math.min(tier, window.innerHeight * 0.68);
        const overflows = isExpanded ? pre.scrollHeight > ceiling + 1 : pre.scrollHeight > pre.clientHeight + 1;
        if (overflows) overflowing.current.add(index); else overflowing.current.delete(index);
        wrapper.classList.toggle("is-overflowing", overflows);
        if (!overflows && isExpanded) expanded.current.delete(index);
        const active = overflows && expanded.current.has(index);
        wrapper.classList.toggle("is-expanded", active);
        button.setAttribute("aria-expanded", String(active));
        const label = active ? "收起全文" : "展开全文";
        if (button.textContent !== label) button.textContent = label;
      });
    };
    const click = (event: MouseEvent) => {
      const button = event.target instanceof Element ? event.target.closest<HTMLButtonElement>(".code-block-expand-button") : null;
      const wrapper = button?.closest<HTMLElement>(".code-block-wrapper");
      if (!button || !wrapper || !layer.contains(wrapper)) return;
      event.preventDefault();
      const index = [...layer.querySelectorAll(".code-block-wrapper")].indexOf(wrapper);
      const pre = wrapper.querySelector<HTMLElement>(".code-block-pre");
      if (index < 0 || !pre) return;
      if (expanded.current.has(index)) {
        expanded.current.delete(index);
        wrapper.classList.remove("is-expanded");
        pre.scrollTop = collapsedScroll.current.get(index) || 0;
      } else {
        collapsedScroll.current.set(index, pre.scrollTop);
        expanded.current.add(index);
        wrapper.classList.add("is-expanded");
      }
      refresh();
    };
    const mutation = new MutationObserver(schedule);
    mutation.observe(layer, { childList: true, subtree: true, characterData: true });
    resize.observe(layer);
    layer.addEventListener("click", click);
    refresh();
    return () => {
      if (frame !== null) window.cancelAnimationFrame(frame);
      mutation.disconnect();
      resize.disconnect();
      layer.removeEventListener("click", click);
    };
  }, [enabled, layerRef, messageKey]);

  return prepareTarget;
}
