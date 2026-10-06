/**
 * Next.js treats `import "server-only"` as a build-time/server-boundary marker.
 * Standalone Node maintenance scripts do not run through Next's resolver, so
 * TSX-based scripts that import server modules can fail before they reach their
 * own safety checks. This tiny require hook keeps the source marker intact while
 * making controlled maintenance scripts executable under plain Node.
 */
const Module = require("module");

const originalResolveFilename = Module._resolveFilename;

if (!globalThis.__manjuNodeScriptServerOnlyStubRegistered) {
  globalThis.__manjuNodeScriptServerOnlyStubRegistered = true;
  Module._resolveFilename = function resolveServerOnlyForNodeScripts(
    request,
    parent,
    isMain,
    options,
  ) {
    if (request === "server-only") return __filename;
    return originalResolveFilename.call(this, request, parent, isMain, options);
  };
}

module.exports = {};
