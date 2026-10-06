#!/usr/bin/env node

const userAgent = process.env.npm_config_user_agent || "";
const expectedVersion = "9.0.0";
const actualVersion = userAgent.match(/^pnpm\/([^\s]+)/u)?.[1] || "";
if (actualVersion !== expectedVersion) {
  console.error(`This project must be installed with pnpm ${expectedVersion}; current=${actualVersion || "not-pnpm"}.`);
  process.exit(1);
}
