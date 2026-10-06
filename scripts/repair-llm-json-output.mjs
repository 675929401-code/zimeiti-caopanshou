import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function repairUnescapedJsonQuotes(value) {
  const source = String(value || '').trim().replace(/^```(?:json)?\s*/u, '').replace(/\s*```$/u, '');
  const start = source.indexOf('{');
  const end = source.lastIndexOf('}');
  const json = start >= 0 && end > start ? source.slice(start, end + 1) : source;
  let result = '';
  let inString = false;
  let escaped = false;
  for (let index = 0; index < json.length; index += 1) {
    const character = json[index];
    if (!inString) {
      result += character;
      if (character === '"') inString = true;
      continue;
    }
    if (escaped) {
      result += character;
      escaped = false;
      continue;
    }
    if (character === '\\') {
      result += character;
      escaped = true;
      continue;
    }
    if (character !== '"') {
      result += character;
      continue;
    }
    let lookahead = index + 1;
    while (lookahead < json.length && /\s/u.test(json[lookahead])) lookahead += 1;
    const next = json[lookahead];
    const closesString = lookahead >= json.length || [':', ',', '}', ']'].includes(next);
    if (closesString) {
      result += character;
      inString = false;
    } else {
      result += '\\"';
    }
  }
  return result;
}

export function parseRepairableJson(value) {
  const source = String(value || '').trim().replace(/^```(?:json)?\s*/u, '').replace(/\s*```$/u, '');
  try { return JSON.parse(source); } catch {}
  return JSON.parse(repairUnescapedJsonQuotes(source));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const input = path.resolve(process.argv[2] || '');
  const output = path.resolve(process.argv[3] || '');
  assert.ok(input && output && input !== output, 'Usage: node repair-llm-json-output.mjs <input> <output>');
  const project = path.resolve(process.cwd());
  assert.ok(input.startsWith(project) && output.startsWith(project), 'Input and output must stay inside the project');
  const parsed = parseRepairableJson(await fs.readFile(input, 'utf8'));
  await fs.writeFile(output, `${JSON.stringify(parsed, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  console.log(JSON.stringify({ repaired: true, input, output, caseCount: parsed?.cases?.length || 0 }));
}
