#!/usr/bin/env node

// Backward-compatible command name. The product now enforces the stricter
// exclusive user/IP session contract.
await import("./verify-auth-exclusive-session-transaction-local.mjs");
