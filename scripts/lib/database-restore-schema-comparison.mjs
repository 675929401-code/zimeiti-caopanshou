import crypto from 'node:crypto';

export const RESTORE_SCHEMA_RULE_VERSION = 'ordered-and-and-literal-varchar-array.v1';
const sha = text => crypto.createHash('sha256').update(text).digest('hex');
const error = () => { throw new Error('SCHEMA_LEXICAL_INVALID'); };

// Tokens retain source offsets. Literals, comments and function bodies are opaque.
function lex(text) {
  if (text.includes('\0')) error();
  const out = [];
  for (let i = 0; i < text.length;) {
    if (/\s/u.test(text[i])) { i++; continue; }
    const start = i; let kind = 'symbol';
    if (text.startsWith('--', i)) { kind = 'comment'; i = text.indexOf('\n', i); if (i < 0) i = text.length; }
    else if (text.startsWith('/*', i)) {
      kind = 'comment'; i += 2; let depth = 1;
      while (i < text.length && depth) { if (text.startsWith('/*', i)) { depth++; i += 2; } else if (text.startsWith('*/', i)) { depth--; i += 2; } else i++; }
      if (depth) error();
    } else if (text[i] === '"' || text[i] === "'" || (/[Ee]/u.test(text[i]) && text[i + 1] === "'")) {
      const escaped = text[i] !== '"' && text[i] !== "'";
      if (escaped) i++;
      const quote = text[i++]; kind = quote === '"' ? 'identifier' : 'literal'; let closed = false;
      while (i < text.length) {
        if (escaped && text[i] === '\\') { i += 2; continue; }
        if (text[i] === quote) { if (text[i + 1] === quote) { i += 2; continue; } i++; closed = true; break; }
        i++;
      }
      if (!closed) error();
    } else if (text[i] === '$' && /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/u.test(text.slice(i))) {
      const delimiter = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/u.exec(text.slice(i))[0];
      const end = text.indexOf(delimiter, i + delimiter.length); if (end < 0) error();
      kind = 'body'; i = end + delimiter.length;
    } else if (/[A-Za-z_]/u.test(text[i])) { kind = 'word'; while (i < text.length && /[A-Za-z0-9_$]/u.test(text[i])) i++; }
    else if (text.startsWith('::', i)) i += 2;
    else i++;
    out.push({ kind, raw: text.slice(start, i), start, end: i });
  }
  return out;
}
const word = (token, value) => token?.kind === 'word' && token.raw === value;

function arrays(text) {
  const tokens = lex(text); const replacements = []; let count = 0;
  if (tokens.some(token => word(token, 'COLLATE'))) return { text, count };
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].raw !== '::') continue;
    const varchar = word(tokens[i + 1], 'character') && word(tokens[i + 2], 'varying') && !['(', '.'].includes(tokens[i + 3]?.raw);
    const builtinText = ['text', '"text"'].includes(tokens[i + 1]?.raw) && !['(', '.'].includes(tokens[i + 2]?.raw);
    if (!varchar && !builtinText) return { text, count };
  }
  let squareDepth = 0;
  const squareLevels = tokens.map(token => { const level = squareDepth; if (token.raw === '[') squareDepth++; if (token.raw === ']') squareDepth--; return level; });
  const varcharItem = at => {
    const t = tokens;
    if (t[at]?.kind !== 'literal' || t[at + 1]?.raw !== '::' || !word(t[at + 2], 'character') || !word(t[at + 3], 'varying')) return null;
    const raw = text.slice(t[at].start, t[at + 3].end);
    if (raw !== `${t[at].raw}::character varying`) return null;
    return { raw, next: at + 4 };
  };
  for (let i = 0; i < tokens.length; i++) {
    if (squareLevels[i] !== 0) continue;
    const distributed = word(tokens[i], 'ARRAY');
    if (!distributed && !(tokens[i].raw === '(' && word(tokens[i + 1], 'ARRAY'))) continue;
    let p = i + (distributed ? 1 : 2); if (tokens[p++]?.raw !== '[') continue;
    const items = []; let type = null, valid = true;
    for (;;) {
      if (distributed && tokens[p++]?.raw !== '(') { valid = false; break; }
      const item = varcharItem(p); if (!item) { valid = false; break; } p = item.next; items.push(item.raw);
      if (distributed) {
        if (tokens[p++]?.raw !== ')' || tokens[p++]?.raw !== '::') { valid = false; break; }
        const value = tokens[p++]?.raw; if (!['text', '"text"'].includes(value) || (type && type !== value)) { valid = false; break; } type = value;
      }
      if (tokens[p]?.raw !== ',') break; p++;
    }
    if (!valid || tokens[p++]?.raw !== ']') continue;
    if (!distributed) {
      if (tokens[p++]?.raw !== ')' || tokens[p++]?.raw !== '::') continue;
      type = tokens[p++]?.raw;
      if (!['text', '"text"'].includes(type) || tokens[p++]?.raw !== '[' || tokens[p++]?.raw !== ']') continue;
    }
    if (['[', '.', '::'].includes(tokens[p]?.raw) || word(tokens[p], 'COLLATE')) continue;
    const end = tokens[p - 1].end;
    const expected = distributed ? `ARRAY[${items.map(item => `(${item})::${type}`).join(', ')}]` : `(ARRAY[${items.join(', ')}])::${type}[]`;
    if (text.slice(tokens[i].start, end) !== expected) continue;
    replacements.push({ start: tokens[i].start, end, value: `\0ARRAY:${JSON.stringify({ items, type })}\0` }); count++; i = p - 1;
  }
  for (const replacement of replacements.reverse()) text = text.slice(0, replacement.start) + replacement.value + text.slice(replacement.end);
  return { text, count };
}

function expression(text) {
  const tokens = lex(text);
  if (tokens.some(token => ['comment', 'body'].includes(token.kind))) return { text, and: 0, array: 0 };
  function visit(first, last) {
    if (first > last) return { text: '', tree: false, and: 0, array: 0 };
    let depth = 0, square = 0; const operators = [], orOperators = []; let outerClose = -1, blocked = false;
    for (let i = first; i <= last; i++) {
      const token = tokens[i];
      if (!depth && !square && token.kind === 'word' && ['OR', 'NOT', 'BETWEEN', 'CASE'].includes(token.raw)) blocked = true;
      if (!depth && !square && word(token, 'AND')) operators.push(i);
      if (!depth && !square && word(token, 'OR')) orOperators.push(i);
      if (token.raw === '(') depth++;
      if (token.raw === ')') { depth--; if (!depth && outerClose < 0) outerClose = i; }
      if (token.raw === '[') square++;
      if (token.raw === ']') square--;
      if (depth < 0 || square < 0) error();
    }
    if (depth || square) error();
    // Preserve OR structure and its parentheses exactly, while allowing a nested
    // AND subtree to be compared. Never distribute, reorder or simplify OR/NOT.
    if (orOperators.length && !tokens.slice(first, last + 1).some(token => word(token, 'BETWEEN') || word(token, 'CASE'))) {
      let start = first, result = '', and = 0, array = 0;
      for (const at of [...orOperators, last + 1]) {
        const child = visit(start, at - 1); result += child.text; and += child.and; array += child.array;
        if (at <= last) result += text.slice(tokens[at - 1].end, tokens[at + 1].start);
        start = at + 1;
      }
      return { text: result, tree: false, and, array };
    }
    if (!blocked && operators.length) {
      let start = first, result = '', and = 1, array = 0;
      for (const at of [...operators, last + 1]) {
        const child = visit(start, at - 1); and += child.and; array += child.array;
        result += child.text;
        if (at <= last) result += text.slice(tokens[at - 1].end, tokens[at + 1].start);
        start = at + 1;
      }
      return { text: result, tree: true, and, array };
    }
    if (tokens[first].raw === '(' && outerClose === last) {
      const child = visit(first + 1, last - 1);
      if (child.tree) return { ...child, text: text.slice(tokens[first].end, tokens[first + 1].start) + child.text + text.slice(tokens[last - 1].end, tokens[last].start) };
      if (child.and || child.array) return { ...child, text: text.slice(tokens[first].start, tokens[first + 1].start) + child.text + text.slice(tokens[last - 1].end, tokens[last].end) };
    }
    const array = arrays(text.slice(tokens[first].start, tokens[last].end));
    return { text: array.text, tree: false, and: 0, array: array.count };
  }
  if (!tokens.length) return { text, and: 0, array: 0 };
  const result = visit(0, tokens.length - 1);
  return { ...result, text: text.slice(0, tokens[0].start) + result.text + text.slice(tokens.at(-1).end) };
}

function canonicalSchema(text) {
  const tokens = lex(text); const spans = []; let statement = [];
  function inspect(all) {
    const t = all.filter(token => token.kind !== 'comment'); if (!t.length) return;
    const table = word(t[0], 'CREATE') && (word(t[1], 'TABLE') || (word(t[1], 'UNLOGGED') && word(t[2], 'TABLE'))) || word(t[0], 'ALTER') && word(t[1], 'TABLE');
    const index = word(t[0], 'CREATE') && (word(t[1], 'INDEX') || word(t[1], 'UNIQUE') && word(t[2], 'INDEX'));
    if (!table && !index) return;
    const identityStart = table ? (word(t[1], 'UNLOGGED') ? 3 : 2) : (word(t[1], 'UNIQUE') ? 3 : 2);
    const identity = t.slice(identityStart, identityStart + (t[identityStart + 1]?.raw === '.' ? 3 : 1)).map(token => token.raw).join('');
    let depth = 0;
    for (let i = 0; i < t.length; i++) {
      if (table && word(t[i], 'CHECK') && t[i + 1]?.raw === '(') {
        let j = i + 2, nest = 1;
        for (; j < t.length && nest; j++) { if (t[j].raw === '(') nest++; if (t[j].raw === ')') nest--; }
        if (nest) error();
        const start = t[i + 1].end, end = t[j - 1].start;
        const constraint = word(t[i - 2], 'CONSTRAINT') ? t[i - 1].raw : null;
        spans.push({ start, end, object: identity, constraint, kind: 'CHECK', ...expression(text.slice(start, end)) }); i = j - 1;
      } else if (index && !depth && word(t[i], 'WHERE')) {
        const end = t.at(-1).raw === ';' ? t.at(-1).start : t.at(-1).end;
        spans.push({ start: t[i].end, end, object: identity, kind: 'INDEX WHERE', ...expression(text.slice(t[i].end, end)) }); break;
      }
      if (t[i].raw === '(') depth++; if (t[i].raw === ')') depth--;
    }
  }
  for (const token of tokens) { statement.push(token); if (token.raw === ';' && token.kind === 'symbol') { inspect(statement); statement = []; } }
  inspect(statement);
  let canonical = text;
  for (const span of [...spans].reverse()) canonical = canonical.slice(0, span.start) + span.text + canonical.slice(span.end);
  return { canonical, spans };
}

// Input must already have the producer's unchanged outer dump normalization.
export function compareRestoreSchemas(source, restored) {
  const a = canonicalSchema(source), b = canonicalSchema(restored), changes = [];
  let andChanges = 0, arrayChanges = 0;
  for (let i = 0; i < Math.max(a.spans.length, b.spans.length); i++) {
    const left = a.spans[i], right = b.spans[i];
    if (!left || !right) continue;
    const rawLeft = source.slice(left.start, left.end), rawRight = restored.slice(right.start, right.end);
    if (rawLeft === rawRight) continue;
    const equivalent = left.text === right.text && left.object === right.object && left.constraint === right.constraint && left.kind === right.kind;
    const and = equivalent && (left.and || right.and) > 0;
    const array = equivalent && (left.array || right.array) > 0;
    if (and) andChanges++; if (array) arrayChanges++;
    changes.push({ object: left.object, constraint: left.constraint ?? null, kind: left.kind, sourceExpressionSha256: sha(rawLeft), restoredExpressionSha256: sha(rawRight), andAssociativity: and, literalArrayCast: array, classified: equivalent });
  }
  const equivalent = a.canonical === b.canonical;
  return { ruleVersion: RESTORE_SCHEMA_RULE_VERSION, equivalent, sourceRawSha256: sha(source), restoredRawSha256: sha(restored),
    sourceCanonicalSha256: sha(a.canonical), restoredCanonicalSha256: sha(b.canonical), andAssociativityChanges: andChanges,
    literalArrayCastChanges: arrayChanges, unclassifiedDifferenceCount: equivalent ? 0 : Math.max(1, changes.filter(change => !change.classified).length), changes };
}
