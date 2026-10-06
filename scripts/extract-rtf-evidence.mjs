import { readFile } from "node:fs/promises";

const source = process.argv[2];
if (!source) {
  throw new Error("Usage: node scripts/extract-rtf-evidence.mjs <file.rtf>");
}

const raw = await readFile(source);
const latin1 = raw.toString("latin1");
const decoder = new TextDecoder("gb18030");

const ignorableDestinations = new Set([
  "pict", "object", "objdata", "fonttbl", "colortbl", "stylesheet",
  "listtable", "listoverridetable", "info", "generator", "themedata",
  "datastore", "xmlopen", "xmlclose", "xmlattrname", "xmlattrvalue",
]);

const groups = [{ ignored: false, pendingStar: false }];
const bytes = [];
const pushText = (value) => {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code <= 0xff) bytes.push(code);
  }
};

for (let index = 0; index < latin1.length;) {
  const character = latin1[index];
  const state = groups.at(-1);
  if (character === "{") {
    groups.push({ ...state, pendingStar: false });
    index += 1;
    continue;
  }
  if (character === "}") {
    if (groups.length > 1) groups.pop();
    index += 1;
    continue;
  }
  if (character !== "\\") {
    if (!state.ignored && character !== "\r" && character !== "\n") pushText(character);
    index += 1;
    continue;
  }

  const next = latin1[index + 1];
  if (next === "'" && /^[0-9a-f]{2}$/iu.test(latin1.slice(index + 2, index + 4))) {
    if (!state.ignored) bytes.push(Number.parseInt(latin1.slice(index + 2, index + 4), 16));
    index += 4;
    continue;
  }
  if (next === "\\" || next === "{" || next === "}") {
    if (!state.ignored) pushText(next);
    index += 2;
    continue;
  }
  if (next === "*") {
    state.pendingStar = true;
    index += 2;
    continue;
  }
  if (next === "~") {
    if (!state.ignored) pushText(" ");
    index += 2;
    continue;
  }
  if (next === "-") {
    index += 2;
    continue;
  }

  const match = latin1.slice(index).match(/^\\([a-z]+)(-?\d+)? ?/iu);
  if (!match) {
    index += 2;
    continue;
  }
  const [, word, parameter] = match;
  const lowered = word.toLowerCase();
  if (state.pendingStar || ignorableDestinations.has(lowered)) state.ignored = true;
  state.pendingStar = false;
  if (!state.ignored) {
    if (lowered === "par" || lowered === "line") pushText("\n");
    else if (lowered === "tab") pushText("\t");
    else if (lowered === "u" && parameter) {
      const value = Number(parameter);
      const unsigned = value < 0 ? value + 65536 : value;
      pushText(String.fromCharCode(unsigned));
    }
  }
  index += match[0].length;
}

const text = decoder.decode(Uint8Array.from(bytes))
  .replace(/[ \t]+\n/gu, "\n")
  .replace(/\n{3,}/gu, "\n\n")
  .replace(/[ \t]{2,}/gu, " ")
  .trim();

process.stdout.write(`${text}\n`);
