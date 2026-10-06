#!/usr/bin/env node

import path from "node:path";
import { pathToFileURL } from "node:url";

import { main } from "./verify-admin-navigation-desktop-readonly.mjs";

export { main };

if (import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await main();
}
