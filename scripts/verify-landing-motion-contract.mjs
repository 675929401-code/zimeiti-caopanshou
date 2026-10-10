import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const root = process.cwd();
const componentPath = resolve(root, "src/components/landing/soft-white-landing.tsx");
const baseCssPath = resolve(root, "src/components/landing/soft-white-landing.css");
const themeCssPath = resolve(root, "src/components/landing/operating-home-v2.css");
const browserVerifierPath = resolve(root, "scripts/verify-landing-motion-browser-readonly.mjs");
const retiredNetworkPaths = [
  resolve(root, "src/components/landing/pointer-network.tsx"),
  resolve(root, "src/components/landing/pointer-network.css"),
];

const component = readFileSync(componentPath, "utf8");
const baseCss = readFileSync(baseCssPath, "utf8");
const themeCss = readFileSync(themeCssPath, "utf8");
const browserVerifier = readFileSync(browserVerifierPath, "utf8");
const importedCssPaths = [...component.matchAll(/^\s*import\s+["'](\.\/[^"']+\.css)["'];?\s*$/gmu)]
  .map((match) => match[1]);
const landingCssSources = importedCssPaths.map((relativePath) => ({
  relativePath,
  source: readFileSync(resolve(dirname(componentPath), relativePath), "utf8"),
}));
const landingSource = `${component}\n${landingCssSources.map(({ source }) => source).join("\n")}`;

const checks = [];
const check = (name, fn) => {
  fn();
  checks.push(name);
};

function extractBlocks(source, token) {
  const blocks = [];
  let cursor = 0;
  while ((cursor = source.indexOf(token, cursor)) !== -1) {
    const open = source.indexOf("{", cursor + token.length);
    assert.notEqual(open, -1, `Missing opening brace after ${token}`);
    let depth = 1;
    let close = open + 1;
    for (; close < source.length && depth > 0; close += 1) {
      if (source[close] === "{") depth += 1;
      if (source[close] === "}") depth -= 1;
    }
    assert.equal(depth, 0, `Unclosed block after ${token}`);
    blocks.push(source.slice(open + 1, close - 1));
    cursor = close;
  }
  return blocks;
}

function stripCssComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//gu, "");
}

function stripQuotedStrings(source) {
  let clean = "";
  let quote = null;
  let escaped = false;
  for (const character of source) {
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === quote) {
        quote = null;
      }
      clean += " ";
    } else if (character === '"' || character === "'") {
      quote = character;
      clean += " ";
    } else {
      clean += character;
    }
  }
  return clean;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function extractStyleRules(source) {
  const rules = [];
  const cleanSource = stripCssComments(source);
  for (let open = cleanSource.indexOf("{"); open !== -1; open = cleanSource.indexOf("{", open + 1)) {
    const boundary = Math.max(
      cleanSource.lastIndexOf("{", open - 1),
      cleanSource.lastIndexOf("}", open - 1),
      cleanSource.lastIndexOf(";", open - 1),
    );
    const selector = cleanSource.slice(boundary + 1, open).trim();
    if (!selector || selector.startsWith("@")) continue;

    let depth = 1;
    let close = open + 1;
    for (; close < cleanSource.length && depth > 0; close += 1) {
      if (cleanSource[close] === "{") depth += 1;
      if (cleanSource[close] === "}") depth -= 1;
    }
    assert.equal(depth, 0, `Unclosed CSS rule for ${selector}`);
    rules.push({ selector, body: cleanSource.slice(open + 1, close - 1) });
  }
  return rules;
}

const themeRules = extractStyleRules(themeCss);

function assertSelectorDeclaresAnimation(selector) {
  const matchingRules = themeRules.filter((candidate) => candidate.selector.split(",").some((part) => part.trim() === selector));
  assert.ok(matchingRules.length > 0, `${selector} CSS rule is missing`);
  assert.ok(
    matchingRules.some((rule) => /(?:^|;)\s*animation(?:-name)?\s*:/u.test(rule.body)),
    `${selector} must declare its own animation`,
  );
}

function assertSelectorDeclares(selector, declaration) {
  const rule = themeRules.find((candidate) => candidate.selector.split(",").some((part) => part.trim() === selector));
  assert.ok(rule, `${selector} CSS rule is missing`);
  assert.match(rule.body, declaration, `${selector} declaration contract is missing`);
}

check("landing CSS imports", () => {
  assert.ok(importedCssPaths.includes("./soft-white-landing.css"), "Component must import soft-white-landing.css");
  assert.ok(importedCssPaths.includes("./operating-home-v2.css"), "Component must import operating-home-v2.css");
});

check("no-pointer-network contract", () => {
  assert.doesNotMatch(landingSource, /pointer-network|PointerNetwork/u);
  retiredNetworkPaths.forEach((path) => assert.equal(existsSync(path), false, `${path} must remain deleted`));
  assert.doesNotMatch(component, /pointermove|pointerMotion|--swh-pointer-[xy]/u);
});

check("project card motion shell and signal rail", () => {
  assert.match(component, /className="swh-loop-float-shell"/u);
  assert.match(component, /className="swh-loop-signal"/u);
  assert.match(themeCss, /@keyframes swh-project-card-float/u);
  assert.match(themeCss, /@keyframes swh-loop-signal-pulse/u);
  assertSelectorDeclares(
    '.soft-white-home[data-landing-version="v2"] .swh-loop-float-shell:hover',
    /(?:^|;)\s*animation-play-state:\s*paused\s*;?/u,
  );
});

check("non-wave atmospheric motion system", () => {
  const expectedMotionClasses = [
    ["swh-aurora-field", 2],
    ["swh-data-beam", 3],
    ["swh-depth-particle-field", 1],
    ["swh-holo-orbit", 2],
    ["swh-holo-core", 1],
  ];
  for (const [className, expectedCount] of expectedMotionClasses) {
    const classPattern = new RegExp(`className="[^"]*\\b${className}\\b[^"]*"`, "gu");
    assert.equal((component.match(classPattern) || []).length, expectedCount, `${className} DOM count changed`);
    assert.match(themeCss, new RegExp(`\\.${className}(?:[\\s.:,{]|$)`, "u"), `${className} CSS is missing`);
  }
  const rejectedClasses = [
    "swh-energy-ribbon",
    "swh-wave",
    "swh-wave-mesh",
    "swh-wave-signal",
    "swh-factory-ripple",
  ];
  const rejectedKeyframes = ["swh-energy-ribbon", "swh-wave", "swh-factory-ripple"];
  const staticClassNames = [...component.matchAll(/className="([^"]*)"/gu)]
    .flatMap((match) => match[1].trim().split(/\s+/u));
  for (const className of rejectedClasses) {
    assert.equal(staticClassNames.includes(className), false, `${className} must not return to the landing DOM`);
  }
  for (const { relativePath, source } of landingCssSources) {
    const cssWithoutNoise = stripQuotedStrings(stripCssComments(source));
    const selectors = stripQuotedStrings(extractStyleRules(source).map((rule) => rule.selector).join("\n"));
    for (const className of rejectedClasses) {
      assert.doesNotMatch(
        selectors,
        new RegExp(`\\.${escapeRegExp(className)}(?![\\w-])`, "u"),
        `${relativePath} contains rejected class ${className}`,
      );
    }
    for (const keyframeName of rejectedKeyframes) {
      assert.doesNotMatch(
        cssWithoutNoise,
        new RegExp(`@keyframes\\s+${escapeRegExp(keyframeName)}(?![\\w-])`, "u"),
        `${relativePath} contains rejected keyframes ${keyframeName}`,
      );
    }
  }

  for (const selector of [
    '.soft-white-home[data-landing-version="v2"] .swh-aurora-field-one',
    '.soft-white-home[data-landing-version="v2"] .swh-aurora-field-two',
    '.soft-white-home[data-landing-version="v2"] .swh-data-beam-one',
    '.soft-white-home[data-landing-version="v2"] .swh-data-beam-two',
    '.soft-white-home[data-landing-version="v2"] .swh-data-beam-three',
    '.soft-white-home[data-landing-version="v2"] .swh-depth-particle-field',
    '.soft-white-home[data-landing-version="v2"] .swh-holo-orbit-one',
    '.soft-white-home[data-landing-version="v2"] .swh-holo-orbit-two',
    '.soft-white-home[data-landing-version="v2"] .swh-holo-core::before',
  ]) {
    assertSelectorDeclaresAnimation(selector);
  }
});

check("theme visibility and footer structure", () => {
  for (const selector of [
    'html[data-theme="soft-white"][data-mode="light"]',
    'html[data-theme="lattice"][data-mode="dark"]',
    'html[data-theme="crystal-aurora"][data-mode="dark"]',
  ]) {
    assert.ok(themeCss.includes(selector), `${selector} theme contract is missing`);
  }
  assert.match(component, /<section className="swh-section swh-contact"[^>]*data-swh-panel[^>]*>[\s\S]*?<footer className="swh-footer" id="swh-footer"[^>]*>[\s\S]*?<\/footer>\s*<\/section>\s*<\/main>/u);
  assert.match(themeCss, /\.soft-white-home\[data-landing-version="v2"\] \.swh-contact > \.swh-footer/u);
  assert.match(browserVerifier, /themeVisibility/u);
  assert.match(browserVerifier, /LANDING_THEME_NOT_APPLIED/u);
  assert.match(browserVerifier, /\["AURORA_FIELD", visibility\.auroraFields, 2\]/u);
  assert.match(browserVerifier, /\["HOLO_CORE", visibility\.holoCores, 1\]/u);
  assert.match(browserVerifier, /\$\{label\}_NOT_VISIBLE/u);
});

check("stable entrance and hover composition", () => {
  assert.match(themeCss, /@keyframes swh-title-settle/u);
  assert.match(themeCss, /\.swh-loop\s*\{[^}]*translate:\s*0 0;[^}]*scale:\s*1;/su);
  assert.match(themeCss, /@media \(hover: hover\) and \(pointer: fine\)/u);
});

check("typewriter lifecycle and live reduced-motion preference", () => {
  assert.match(component, /const heroPhrases = \[[^\]]+\][\s\S]*?setDeleting\(true\)[\s\S]*?setPhraseIndex\(\(current\) => \(current \+ 1\) % heroPhrases\.length\)/u);
  assert.match(component, /addEventListener\("change", syncPreference\)/u);
  assert.match(component, /removeEventListener\("change", syncPreference\)/u);
  assert.match(browserVerifier, /TYPEWRITER_INPUT_PHASE_MISSING/u);
  assert.match(browserVerifier, /TYPEWRITER_DELETE_PHASE_MISSING/u);
  assert.match(browserVerifier, /TYPEWRITER_DID_NOT_ADVANCE_PHRASE/u);
});

check("one-wheel panel navigation and native reduced-motion scroll", () => {
  assert.match(component, /addEventListener\("wheel", handleWheel, \{ passive: false \}\)/u);
  assert.match(component, /window\.matchMedia\("\(prefers-reduced-motion: reduce\)"\)\.matches[\s\S]*?return;/u);
  assert.match(component, /freeScroll\.scrollHeight - freeScroll\.clientHeight/u);
  assert.match(component, /if \(canConsume\) return;/u);
  assert.match(component, /Math\.max\(0, home\.scrollHeight - home\.clientHeight\)/u);
  assert.match(component, /event\.preventDefault\(\);[\s\S]*?boundaryTop/u);
  assert.match(browserVerifier, /WHEEL_LOCK_SKIPPED_PANEL/u);
  assert.match(browserVerifier, /FREE_SCROLL_ZONE_TRIGGERED_PANEL_NAVIGATION/u);
  assert.match(browserVerifier, /REDUCED_MOTION_WHEEL_WAS_FORCED_TO_PANEL/u);
  assert.match(browserVerifier, /LAST_SCREEN_DOWNWARD_SCROLL_BOUNCED/u);
});

check("reduced motion fallback", () => {
  const reducedBlocks = [
    ...extractBlocks(baseCss, "@media (prefers-reduced-motion: reduce)"),
    ...extractBlocks(themeCss, "@media (prefers-reduced-motion: reduce)"),
  ];
  assert.ok(reducedBlocks.length >= 2, "Both landing CSS layers must define reduced-motion behavior");
  const reduced = reducedBlocks.join("\n");
  assert.match(reduced, /animation-duration:\s*\.01ms\s*!important/u);
  assert.match(reduced, /swh-loop-float-shell/u);
  assert.match(reduced, /swh-aurora-field/u);
  assert.match(reduced, /swh-data-beam/u);
  assert.match(reduced, /swh-depth-particle-field/u);
  assert.match(reduced, /swh-holo-orbit/u);
  assert.match(reduced, /swh-holo-core/u);
  assert.match(reduced, /animation:\s*none\s*!important/u);
  assert.match(reduced, /scroll-snap-type:\s*none/u);
  assert.match(themeCss, /\.soft-white-home\[data-landing-version="v2"\] \*,[\s\S]*?animation:\s*none\s*!important/u);
  assert.match(browserVerifier, /DYNAMIC_REDUCED_MOTION_LEFT_ACTIVE_ANIMATIONS/u);
  assert.match(browserVerifier, /REDUCED_MOTION_LEFT_ACTIVE_ANIMATIONS/u);
});

check("browser motion evidence covers paint and progression", () => {
  assert.match(browserVerifier, /PROJECT_CARD_TRANSIENT_FLASH/u);
  assert.match(browserVerifier, /PROJECT_CARD_FLOAT_NOT_PROGRESSING/u);
  assert.match(browserVerifier, /PROJECT_CARD_FLOAT_MUST_PAUSE_ON_HOVER/u);
  assert.match(browserVerifier, /PROJECT_CARD_SIGNAL_PULSE_NOT_PROGRESSING/u);
  assert.match(browserVerifier, /RETIRED_WAVE_RIPPLE_DOM_PRESENT/u);
  assert.match(browserVerifier, /ROOT_BEFORE_NOT_SUBTLE/u);
  assert.match(browserVerifier, /\$\{label\}_NOT_PAINTED/u);
  assert.match(browserVerifier, /assertDecorationProgress\("auroraFields", "AURORA_FIELD", 2\)/u);
  assert.match(browserVerifier, /assertDecorationProgress\("dataBeams", "DATA_BEAM", 3,/u);
  assert.match(browserVerifier, /assertDecorationProgress\("depthParticleFields", "DEPTH_PARTICLE_FIELD", 1\)/u);
  assert.match(browserVerifier, /assertDecorationProgress\("holoOrbits", "HOLO_ORBIT", 2\)/u);
  assert.match(browserVerifier, /assertDecorationProgress\("holoCores", "HOLO_CORE", 1\)/u);
  assert.match(browserVerifier, /LAST_SCREEN_NOT_REACHED/u);
  assert.match(browserVerifier, /LAST_SCREEN_DOWNWARD_SCROLL_SHIFTED/u);
  assert.match(browserVerifier, /LAST_SCREEN_DOWNWARD_SCROLL_LEAKED_TO_WINDOW/u);
  assert.match(browserVerifier, /LAST_SCREEN_DOWNWARD_SCROLL_BOUNCED/u);
});

check("no horizontal overflow contract", () => {
  assert.match(themeCss, /\.soft-white-home\[data-landing-version="v2"\]\s*\{[^}]*overflow-x:\s*(?:hidden|clip)/su);
  assert.match(themeCss, /\.swh-loop-float-shell\s*\{[^}]*min-width:\s*0/su);
});

check("keyframes avoid layout properties", () => {
  const keyframes = extractBlocks(`${baseCss}\n${themeCss}`, "@keyframes ");
  assert.ok(keyframes.length > 0, "Expected landing keyframes");
  const layoutProperty = /(?:^|[;{}]\s*)(?:top|right|bottom|left|inset|width|height|min-width|max-width|min-height|max-height|margin(?:-[a-z]+)?|padding(?:-[a-z]+)?|gap|row-gap|column-gap|grid-template(?:-[a-z]+)?|flex-basis|font-size|line-height)\s*:/imu;
  keyframes.forEach((body, index) => assert.doesNotMatch(body, layoutProperty, `Keyframe block ${index + 1} animates layout`));
});

console.log(JSON.stringify({
  schemaVersion: 1,
  suite: "landing-motion-contract",
  status: "passed",
  checks,
  networkCalls: 0,
  productionWrites: 0,
}, null, 2));
