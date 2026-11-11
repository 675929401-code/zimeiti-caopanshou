import assert from 'node:assert/strict';

/** Measure painted edges after layout, including the panel with actual content. */
export async function assertToolboxPanelAlignment(page) {
  const edges = await page.locator('[data-page="tools"]').evaluate(root => {
    const rail = root.querySelector('aside[aria-label="工具功能"]');
    const editor = rail.nextElementSibling;
    const heading = [...editor.querySelectorAll('.toolbox-embedded-toolbar:has(> .min-w-0), h2')]
      .find(node => node.getBoundingClientRect().height > 1 && node.getBoundingClientRect().width > 1);
    const box = node => {
      const { top, bottom, left, right } = node.getBoundingClientRect();
      return { top, bottom, left, right };
    };
    return {
      rail: box(rail), editor: box(editor), directoryHeading: box(rail.firstElementChild),
      editorHeading: box(heading.tagName === 'H2' ? heading.parentElement : heading),
      back: box(root.querySelector('.sub-page-back')), feedback: box(root.querySelector('.public-contact-trigger')),
      pageWidth: root.clientWidth,
    };
  });
  const equal = (a, b, label) => assert.ok(Math.abs(a - b) <= 0.5, `${label}: ${a} vs ${b}`);
  equal(edges.rail.top, edges.editor.top, 'panel tops');
  equal(edges.rail.bottom, edges.editor.bottom, 'panel bottoms');
  equal(edges.directoryHeading.bottom, edges.editorHeading.bottom, 'heading dividers');
  equal(edges.rail.left, edges.pageWidth - edges.editor.right, 'outer gutters');
  equal(edges.back.left, edges.rail.left, 'back button and directory');
  equal(edges.feedback.right, edges.editor.right, 'feedback button and editor');
  return edges;
}
