import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const jsonPath = path.join(root, 'docs', 'storyboard-high-energy-semantic-packaging-library-v1.json');
const payload = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));

const requiredTop = ['schema_version', 'version', 'generated_at', 'families', 'entries', 'calling_syntax'];
const requiredEntry = [
  'id',
  'family',
  'semantic_state',
  'symbol',
  'scale_position_material_center',
  'interaction',
  'effect_lifecycle',
  'palette',
  'camera',
  'video_action',
  'variation_axes',
  'avoid',
];

const errors = [];

for (const field of requiredTop) {
  if (!(field in payload)) errors.push(`missing top field: ${field}`);
}

if (!Array.isArray(payload.entries)) {
  errors.push('entries must be an array');
} else {
  if (payload.entries.length !== 50) {
    errors.push(`expected 50 entries, got ${payload.entries.length}`);
  }

  const ids = new Set();
  for (const entry of payload.entries) {
    if (ids.has(entry.id)) errors.push(`duplicate id: ${entry.id}`);
    ids.add(entry.id);

    for (const field of requiredEntry) {
      if (!(field in entry)) {
        errors.push(`${entry.id ?? '<unknown>'} missing field: ${field}`);
      } else if (Array.isArray(entry[field])) {
        if (entry[field].length === 0) errors.push(`${entry.id} empty array field: ${field}`);
      } else if (typeof entry[field] !== 'string' || entry[field].trim().length === 0) {
        errors.push(`${entry.id} empty string field: ${field}`);
      }
    }

    if (!Array.isArray(entry.variation_axes) || entry.variation_axes.length < 2) {
      errors.push(`${entry.id} must have at least 2 variation axes`);
    }
    if (typeof entry.avoid !== 'string' || entry.avoid.trim().length < 8) {
      errors.push(`${entry.id} must have a concrete avoid boundary`);
    }
  }

  const familyCounts = new Map();
  for (const family of payload.families ?? []) familyCounts.set(family, 0);
  for (const entry of payload.entries) {
    familyCounts.set(entry.family, (familyCounts.get(entry.family) ?? 0) + 1);
  }
  if (familyCounts.size !== 10) {
    errors.push(`expected 10 families, got ${familyCounts.size}`);
  }
  for (const [family, count] of familyCounts) {
    if (count !== 5) errors.push(`family "${family}" expected 5 entries, got ${count}`);
  }
}

if (!Array.isArray(payload.simulations) || payload.simulations.length < 5) {
  errors.push('expected at least 5 no-cost simulations');
} else {
  const entryIds = new Set((payload.entries ?? []).map((entry) => entry.id));
  const selectedIds = new Set();
  for (const simulation of payload.simulations) {
    if (!simulation.copy || !simulation.selected_id || !simulation.why) {
      errors.push('each simulation must include copy, selected_id and why');
      continue;
    }
    if (!entryIds.has(simulation.selected_id)) {
      errors.push(`simulation points to unknown entry: ${simulation.selected_id}`);
    }
    selectedIds.add(simulation.selected_id);
  }
  if (selectedIds.size < 5) {
    errors.push(`expected 5 distinct selected simulation entries, got ${selectedIds.size}`);
  }
}

const result = {
  ok: errors.length === 0,
  checked_at: new Date().toISOString(),
  entries: payload.entries?.length ?? 0,
  simulations: payload.simulations?.length ?? 0,
  distinct_simulation_selected_entries: new Set((payload.simulations ?? []).map((item) => item.selected_id)).size,
  families: Object.fromEntries(
    (payload.families ?? []).map((family) => [
      family,
      (payload.entries ?? []).filter((entry) => entry.family === family).length,
    ]),
  ),
  errors,
};

fs.mkdirSync(path.join(root, '.tmp-e2e'), { recursive: true });
fs.writeFileSync(
  path.join(root, '.tmp-e2e', 'storyboard-semantic-packaging-library-v1-validation.json'),
  `${JSON.stringify(result, null, 2)}\n`,
  'utf8',
);

if (!result.ok) {
  console.error(JSON.stringify(result, null, 2));
  process.exit(1);
}

console.log(JSON.stringify(result, null, 2));
