import { readFile, writeFile } from "node:fs/promises";
import { STORYBOARD_AGENT_PROMPT } from "../src/lib/storyboard-workbench.ts";

const path = "docs/10秒故事板导演智能体提示词-v2.md";
const fence = String.fromCharCode(96).repeat(3);
const document = await readFile(path, "utf8");
const start = document.indexOf(`${fence}text\n`);
const end = document.indexOf(`\n${fence}`, start + fence.length + 5);
if (start < 0 || end <= start) throw new Error("交付文档缺少系统提示词代码块");
const next = `${document.slice(0, start + fence.length + 5)}${STORYBOARD_AGENT_PROMPT.replace(/\r\n/g, "\n")}${document.slice(end)}`;
await writeFile(path, next, "utf8");
console.log(JSON.stringify({ path, promptLength: STORYBOARD_AGENT_PROMPT.length }, null, 2));
