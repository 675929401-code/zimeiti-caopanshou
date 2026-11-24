'use client';
import { useEffect, useState } from 'react';
import { HOME_QUICK_TOOLS, IMAGE_SKILLS, SCENARIOS } from './catalog';

export type HomeScenario = (typeof SCENARIOS)[number];
export type HomeImageSkill = (typeof IMAGE_SKILLS)[number];
export type HomeQuickTool = (typeof HOME_QUICK_TOOLS)[number] & { icon: string };
export type HomeCatalog = { scenarios: HomeScenario[]; imageSkills: HomeImageSkill[]; quickTools: HomeQuickTool[] };

const QUICK_TOOL_ICONS = ['canvas', 'editor', 'enhance', 'watermark', 'subtitle', 'character'];
const baseline: HomeCatalog = {
  scenarios: [...SCENARIOS],
  imageSkills: [...IMAGE_SKILLS],
  quickTools: HOME_QUICK_TOOLS.map((item, index) => ({ ...item, icon: `/commerce/home-tools/${QUICK_TOOL_ICONS[index] || 'canvas'}.svg` })),
};

export function baselineHomeCatalog(): HomeCatalog {
  return baseline;
}

function validCatalog(value: unknown): HomeCatalog | null {
  const catalog = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
  const scenarios = Array.isArray(catalog.scenarios) ? catalog.scenarios : null;
  const imageSkills = Array.isArray(catalog.imageSkills) ? catalog.imageSkills : null;
  const quickTools = Array.isArray(catalog.quickTools) ? catalog.quickTools : null;
  if (!scenarios?.length || !imageSkills?.length || !quickTools?.length) return null;
  return { scenarios, imageSkills, quickTools } as HomeCatalog;
}

/**
 * Member-facing homepage catalog. The code baseline renders instantly; the
 * published admin overlays replace it after a single read. Baseline keeps
 * every functional field (ids, slots, routes); only display fields differ.
 */
export function useHomeCatalog(): HomeCatalog {
  const [catalog, setCatalog] = useState<HomeCatalog>(baseline);
  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch('/api/commerce/home-catalog', { signal: controller.signal });
        const body = await response.json();
        if (!response.ok || body?.ok !== true) return;
        const next = validCatalog(body.catalog);
        if (next && !controller.signal.aborted) setCatalog(next);
      } catch {
        // Baseline stays: display config must never block the workspace.
      }
    })();
    return () => controller.abort();
  }, []);
  return catalog;
}
