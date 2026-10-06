import { createHash } from 'node:crypto';

/** JSON object key order is irrelevant; array order and every value remain significant. */
export function manjuConfigSemanticHash(value) {
  const canonical = entry => Array.isArray(entry) ? entry.map(canonical) : entry && typeof entry === 'object'
    ? Object.fromEntries(Object.keys(entry).sort().map(key => [key, canonical(entry[key])])) : entry;
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}
