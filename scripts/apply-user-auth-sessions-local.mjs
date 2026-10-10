#!/usr/bin/env node

// Backward-compatible command name. The superseding migration keeps its own
// explicit local-execution confirmation gate.
await import("./apply-auth-exclusive-session-local.mjs");
