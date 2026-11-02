import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import * as jsxRuntime from "react/jsx-runtime";
import * as modelBrand from "../src/lib/model-brand";

globalThis.fetch = async () => { throw new Error("NETWORK_FORBIDDEN"); };
const checks: string[] = [];
const check = (name: string, run: () => void) => { run(); checks.push(name); };
const appearance = modelBrand.resolveModelBadgeAppearance;
const google = modelBrand.modelBrandAsset("google");
const byteDance = modelBrand.modelBrandAsset("bytedance");
const generic = modelBrand.modelBrandAsset("generic");

check("Omni aliases with conflicting stock avatars have one neutral source and retain no false upstream", () => {
  for (const name of ["Omni · 720P", "Omni Flash · 720P/1080P", "Omni Video Edit · 720P"]) {
    for (const configured of ["/model-brands/google.svg", google, "/model-brands/bytedance.svg", byteDance, "/model-brands/doubao.svg"]) {
      const resolved = appearance(name, configured, ["omni-flash-channel-c"]);
      assert.equal(resolved.brand, null);
      assert.deepEqual(resolved.candidates, [{ source: generic, kind: "generic" }]);
    }
  }
});

check("strong model families outrank a relay brand and bare Omni has token boundaries", () => {
  assert.equal(modelBrand.resolveModelBrand("Google relay", "grok-video-1"), "xai");
  assert.equal(modelBrand.resolveModelBrand("Grok Video", "google"), "xai");
  assert.equal(modelBrand.resolveModelBrand("OpenAI", "Seedance 2.0"), "bytedance");
  assert.equal(modelBrand.resolveModelBrand("OpenAI", "Veo 3.1"), "google");
  assert.equal(modelBrand.resolveModelBrand("Omni Flash", "seedance-2.0"), "bytedance");
  assert.equal(modelBrand.resolveModelBrand("GPT-Omni", "google"), "openai");
  assert.equal(modelBrand.resolveModelBrand("OpenAI Omni"), "openai");
  assert.equal(modelBrand.resolveModelBrand("Qwen-Omni", "google"), "qwen");
  assert.equal(modelBrand.resolveModelBrand("OmniHuman"), null);
  assert.equal(modelBrand.resolveModelBrand("OmniHuman", "bytedance"), null);
  assert.equal(modelBrand.resolveModelBrand("即梦 OmniHuman1.5 · 照片说话"), "bytedance");
  assert.equal(modelBrand.resolveModelBrand("Omni Flash", "google"), null);
});

check("known stock corrections use the family asset and never retain the wrong logo as fallback", () => {
  for (const [name, brand] of [["Veo 3.1", "google"], ["Gemini 3 Pro Image", "google"], ["Seedance 2.0", "bytedance"],
    ["Grok Video", "xai"], ["Kling 3.0", "kling"], ["GPT Image 2", "openai"]] as const) {
    const wrong = brand === "bytedance" ? google : byteDance;
    const resolved = appearance(name, wrong);
    assert.equal(resolved.brand, brand);
    assert.deepEqual(resolved.candidates, [{ source: modelBrand.modelBrandAsset(brand), kind: "brand" }, { source: generic, kind: "generic" }]);
    assert.equal(resolved.candidates.some(candidate => candidate.source === wrong), false);
  }
  assert.equal(appearance("Seedance 2.0", byteDance).candidates[0].source, byteDance);
  assert.equal(appearance("Veo 3.1", "/model-brands/google.svg").candidates[0].source, google);
  assert.equal(appearance("Seedance 2.0", `${google}?v=old`).candidates[0].source, byteDance);
});

check("custom images remain preferred and arbitrary model-brands paths are not stock", () => {
  for (const custom of ["/uploads/my-logo.webp", "/model-brands/customer-logo.svg", "https://cdn.example.invalid/avatar.svg",
    "https://cdn.example.invalid/model-brands/google.svg", "data:image/svg+xml;base64,PHN2Zy8+", "blob:custom-image"]) {
    for (const name of ["Veo 3.1", "Omni Flash"]) assert.deepEqual(appearance(name, custom).candidates[0], { source: custom, kind: "avatar" });
  }
  const unknown = appearance("Unlisted model", "/model-brands/kling.svg");
  assert.deepEqual(unknown.candidates[0], { source: "/model-brands/kling.svg", kind: "avatar" });
  assert.deepEqual(appearance("Unlisted model").candidates, [{ source: generic, kind: "generic" }]);
});

check("single-value editor preview aliases and brand option keys stay compatible", () => {
  assert.equal(modelBrand.displayModelAvatar("/model-brands/google.svg"), google);
  assert.equal(modelBrand.displayModelAvatar("/model-brands/bytedance.svg"), byteDance);
  assert.equal(modelBrand.displayModelAvatar("/model-brands/openai.svg"), modelBrand.modelBrandAsset("openai"));
  assert.equal(modelBrand.displayModelAvatar("/uploads/brand.png"), "/uploads/brand.png");
  assert.equal(modelBrand.MODEL_BRAND_OPTIONS.find(option => option.key === "google")?.label, "Google / Veo");
});

type ElementNode = { type: string; props: Record<string, unknown> & { children?: ElementNode | ElementNode[] } };
type BadgeProps = { name: string; avatarUrl?: string; identity?: string[]; selected?: boolean; availability?: string };
function badgeHarness() {
  const slots: unknown[] = [];
  let hook = 0;
  let effects: Array<() => void> = [];
  const hooks = {
    useState(initial: unknown) {
      const index = hook++;
      if (!(index in slots)) slots[index] = initial;
      return [slots[index], (value: unknown) => { slots[index] = typeof value === "function" ? (value as (previous: unknown) => unknown)(slots[index]) : value; }];
    },
    useEffect(effect: () => void, deps: unknown[]) {
      const index = hook++;
      const previous = slots[index] as unknown[] | undefined;
      if (!previous || deps.some((value, i) => value !== previous[i])) effects.push(effect);
      slots[index] = deps;
    },
    useMemo(callback: () => unknown) { hook++; return callback(); },
  };
  const harnessModule = { exports: {} as { ModelBadge: (props: BadgeProps) => ElementNode } };
  const source = readFileSync(new URL("../src/components/model-badge.tsx", import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  runInNewContext(compiled, { module: harnessModule, exports: harnessModule.exports, require(id: string) {
    if (id === "react") return hooks;
    if (id === "react/jsx-runtime") return jsxRuntime;
    if (id === "@/lib/model-brand") return modelBrand;
    if (id === "./model-badge.module.css") return { default: {} };
    throw new Error(`Unexpected dependency: ${id}`);
  } }, { timeout: 1000 });
  return {
    render(props: BadgeProps) {
      let node: ElementNode;
      do {
        hook = 0;
        effects = [];
        node = harnessModule.exports.ModelBadge(props);
        for (const effect of effects) effect();
      } while (effects.length);
      return node;
    },
  };
}
function image(node: ElementNode) {
  const children = Array.isArray(node.props.children) ? node.props.children : [node.props.children];
  return children.find(child => child?.type === "img");
}
function failImage(node: ElementNode) {
  const current = image(node);
  assert.ok(current, "An image is required to exercise its real onError handler");
  (current.props.onError as () => void)();
}

check("actual badge falls custom→correct family→generic→initial and keeps visual state attributes", () => {
  const harness = badgeHarness();
  const props = { name: "Veo 3.1", avatarUrl: "/uploads/custom.webp", selected: true, availability: "unavailable" };
  let node = harness.render(props);
  assert.equal(image(node)?.props.src, props.avatarUrl);
  assert.equal(node.props["data-selected"], "true");
  assert.equal(node.props["data-availability"], "unavailable");
  failImage(node); node = harness.render(props);
  assert.equal(image(node)?.props.src, google);
  assert.equal(node.props["data-model-badge-source"], "brand");
  failImage(node); node = harness.render(props);
  assert.equal(image(node)?.props.src, generic);
  failImage(node); node = harness.render(props);
  assert.equal(image(node), undefined);
  assert.equal(node.props["data-model-badge-source"], "initial");
});

check("wrong stock source cannot reappear after corrected family image fails", () => {
  const harness = badgeHarness();
  const props = { name: "Seedance 2.0", avatarUrl: google };
  let node = harness.render(props);
  assert.equal(image(node)?.props.src, byteDance);
  failImage(node); node = harness.render(props);
  assert.equal(image(node)?.props.src, generic);
  failImage(node); node = harness.render(props);
  assert.equal(image(node), undefined);
});

check("switching models resets a failed shared generic source and custom avatar changes reset too", () => {
  const harness = badgeHarness();
  let node = harness.render({ name: "Omni Flash", avatarUrl: google, identity: ["channel-c"] });
  failImage(node);
  assert.equal(image(harness.render({ name: "Omni Flash", avatarUrl: google, identity: ["channel-c"] })), undefined);
  node = harness.render({ name: "Omni Video Edit", avatarUrl: byteDance, identity: ["channel-a"] });
  assert.equal(image(node)?.props.src, generic);
  node = harness.render({ name: "Omni Video Edit", avatarUrl: "/uploads/custom-new.svg" });
  assert.equal(image(node)?.props.src, "/uploads/custom-new.svg");
});

const catalogResults: Array<{ fixture: string; models: number; neutralOmni: number; payloadUnchanged: boolean }> = [];
for (const argument of process.argv.slice(2).filter(value => value.startsWith("--catalog-fixture="))) {
  const fixture = argument.slice("--catalog-fixture=".length);
  check(`public catalog ${path.basename(fixture)} preserves all IDs, names, prices and channels`, () => {
    const catalog = JSON.parse(readFileSync(fixture, "utf8").replace(/^\uFEFF/u, "")) as { models?: Array<Record<string, unknown>> };
    assert.ok(Array.isArray(catalog.models) && catalog.models.length > 0);
    const before = JSON.stringify(catalog);
    let neutralOmni = 0;
    for (const item of catalog.models) {
      const name = String(item.displayName || item.name || item.display_name || "");
      const configured = String(item.avatarUrl || item.avatar_url || item.icon_url || "");
      const badge = appearance(name, configured, [String(item.id || "")]);
      assert.ok(badge.candidates.length > 0);
      assert.equal(new Set(badge.candidates.map(candidate => candidate.source)).size, badge.candidates.length);
      if (/^omni(?:\s|·|$)/iu.test(name) && ["/model-brands/google.svg", "/model-brands/bytedance.svg"].includes(configured)) {
        assert.equal(badge.brand, null);
        assert.deepEqual(badge.candidates, [{ source: generic, kind: "generic" }]);
        neutralOmni++;
      }
    }
    assert.equal(JSON.stringify(catalog), before, "Pure rendering must leave the complete catalog payload unchanged");
    catalogResults.push({ fixture: path.basename(fixture), models: catalog.models.length, neutralOmni, payloadUnchanged: true });
  });
}

console.log(JSON.stringify({ passed: true, checks, catalogs: catalogResults, networkRequests: 0, databaseWrites: 0 }, null, 2));
