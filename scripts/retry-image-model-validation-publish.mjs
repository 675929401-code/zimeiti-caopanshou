#!/usr/bin/env node

// Disabled on 2026-10-10: real image generation acceptance must originate
// from an authenticated user clicking the generate control in the product UI.
// Direct API submission cannot represent local or production browser behavior.
// Use a browser-driven UI acceptance flow that passively records the request,
// task lifecycle, billing, history, rendered asset, and download result.

process.stderr.write(
  "DISABLED_DIRECT_MEDIA_SUBMISSION: run real image validation from the self-media platform UI.\n",
);
process.exitCode = 2;
