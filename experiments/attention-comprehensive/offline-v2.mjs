import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { AttentionMemory } from './retrieval-v2.mjs';
import { memories, probes } from './fixtures.mjs';
import { freshProbes } from './probes-v2.mjs';
const dir = fileURLToPath(new URL('.', import.meta.url));
function evaluate(items) {
  return items.map((p, i) => {
    const engine = new AttentionMemory({ memories });
    engine.observeUser({ text: p.text, day: p.day, turnId: `p-${i}` });
    const selection = engine.select({ text: p.text, day: p.day });
    const ids = selection.selected.map(x => x.id);
    return { ...p, selected: ids, hit: p.want.length ? p.want.some(id => ids.includes(id)) : ids.length === 0, diagnostics: selection.diagnostics };
  });
}
const result = { notes: 'Old 16 probes now regressions, not independent validation after diagnosis. Fresh 10 questions frozen before v2 completion and not supplied to implementer. Hit is not precision or factual correctness.', regression: evaluate(probes), fresh: evaluate(freshProbes) };
fs.writeFileSync(`${dir}offline-v2-results.json`, JSON.stringify(result, null, 2));
console.log(JSON.stringify({ regressionHits: result.regression.filter(p => p.hit).length, regressionCount: result.regression.length, freshHits: result.fresh.filter(p => p.hit).length, freshCount: result.fresh.length, misses: [...result.regression, ...result.fresh].filter(p => !p.hit).map(p => ({ text: p.text, want: p.want, selected: p.selected })) }));
