'use strict';
// Build-only compatibility for Next's absolute exclusion globs on Windows.
// Keep installed dependencies unchanged; POSIX and relative globs are untouched.
const path = require('node:path');
const Module = require('node:module');
const normalize = value => typeof value === 'string' && path.win32.isAbsolute(value) ? value.replaceAll('\\', '/') : value;
const normalizePatterns = value => Array.isArray(value) ? value.map(normalize) : normalize(value);
if (process.platform === 'win32' && !Module.__nextWindowsTraceGlobs) {
  Module.__nextWindowsTraceGlobs = true;
  const load = Module._load;
  const wrappers = new WeakMap();
  Module._load = function(request, parent, isMain) {
    const exported = load.apply(this, arguments);
    if (typeof exported !== 'function' || !/(?:picomatch|glob)/.test(String(request))) return exported;
    const resolved = Module._resolveFilename(request, parent).replaceAll('\\', '/');
    if (resolved.includes('/next/dist/compiled/glob/')) {
      if (wrappers.has(exported)) return wrappers.get(exported);
      const checkout = normalize(process.cwd()).replace(/\/$/, '');
      function boundedOptions(pattern, options) {
        // NFT turns dynamic runtime directories into checkout-wide globstars.
        // Its node_modules/**/* ignore filters files but does not prune the
        // directory walk. Prune dependency/cache/archive roots before walking,
        // matching the existing standalone exclusions. Explicit resource globs
        // (including inside a package or .next) retain their original behavior.
        if (typeof pattern !== 'string' || !normalize(pattern).startsWith(checkout + '/**/')) return options;
        const nonRuntime = ['.next', '.next-validation', '.next-local-acceptance', '.next-local-acceptance-next', '.codex-backups', '.codex-evidence', '.codex-temp', '.tmp-e2e', '.secure', 'artifacts', 'assets', 'backups', 'data', 'deploy', 'docs', 'evidence-archive', 'prompts', 'research', 'research-output', 'scripts', 'src', 'supabase', 'tests', 'voice-platform', '任务快照', '备份快照'];
        const previous = options?.ignore ? [].concat(options.ignore) : [];
        return { ...options, ignore: [...previous, checkout + '/**/node_modules/**', ...nonRuntime.map(name => checkout + '/' + name + '/**')] };
      }
      function boundedGlob(pattern, options, callback) {
        if (typeof options === 'function') return exported(pattern, boundedOptions(pattern, {}), options);
        return exported(pattern, boundedOptions(pattern, options), callback);
      }
      Object.assign(boundedGlob, exported);
      if (exported.glob === exported) boundedGlob.glob = boundedGlob;
      if (typeof exported.sync === 'function') boundedGlob.sync = (pattern, options) => exported.sync(pattern, boundedOptions(pattern, options));
      wrappers.set(exported, boundedGlob);
      return boundedGlob;
    }
    if (!resolved.includes('/next/dist/compiled/picomatch/')) return exported;
    if (wrappers.has(exported)) return wrappers.get(exported);
    function factory(pattern, ...options) {
      const match = exported(normalizePatterns(pattern), ...options);
      if (typeof match !== 'function') return match;
      const wrapped = (input, ...args) => match(normalize(input), ...args);
      return Object.assign(wrapped, match);
    }
    Object.assign(factory, exported);
    wrappers.set(exported, factory);
    return factory;
  };
}
