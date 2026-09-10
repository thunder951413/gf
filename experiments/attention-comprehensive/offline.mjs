import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { AttentionMemory } from './retrieval.mjs';
import { memories, probes } from './fixtures.mjs';
const dir = fileURLToPath(new URL('.', import.meta.url));
const probeResults = probes.map((probe, i) => {
  const engine = new AttentionMemory({ memories });
  engine.observeUser({ text: probe.text, day: probe.day, turnId: `heldout-${i}` });
  const selection = engine.select({ text: probe.text, day: probe.day });
  const ids = selection.selected.map(m => m.id);
  return { ...probe, selected: ids, anyExpectedFound: probe.want.length ? probe.want.some(id => ids.includes(id)) : ids.length === 0, allExpectedFound: probe.want.every(id => ids.includes(id)), diagnostics: selection.diagnostics };
});
const runs = [];
for (const halfLife of [1, 3, 7]) for (const recordExposure of [false, true]) for (const seed of [1, 7, 42, 99, 123]) {
  const engine = new AttentionMemory({ memories, halfLife, seed });
  const events = [];
  for (let day = 0; day <= 90; day++) {
    const focus = engine.select({ day, mode: 'proactive', maxItems: 1 });
    const selected = focus.selected[0];
    events.push({ day, id: selected?.id || null, score: selected?.score ?? 0 });
    // Idealized exact-detail delivery isolates exposure mechanics. This is not
    // a generated conversational reply and is labelled as such in results.
    if (selected && recordExposure) engine.observeAssistant({ text: selected.text, day, turnId: `delivery-${day}`, selectedIds: [selected.id] });
  }
  const deliveries = events.filter(e => e.id);
  const consecutiveRepeats = deliveries.slice(1).filter((e, i) => e.id === deliveries[i].id && e.day === deliveries[i].day + 1).length;
  runs.push({ halfLife, recordExposure, seed, deliveries: deliveries.length, uniqueDetails: new Set(deliveries.map(e => e.id)).size, consecutiveRepeats, emptyDays: events.length - deliveries.length, lastDeliveryDay: deliveries.at(-1)?.day ?? null, events });
}
const out = { notes: ['Held-out queries are evaluated after retrieval; want labels are never passed into the engine.', 'Long-horizon runs use exact selected text as idealized delivered content, not model output.', 'This tests a fixed content pool with its scheduled events. Real life generation and source fetching are not simulated.'], probeResults, runs };
fs.writeFileSync(`${dir}offline-results.json`, JSON.stringify(out, null, 2));
console.log(JSON.stringify({ probes: probeResults.length, anyHit: probeResults.filter(x => x.anyExpectedFound).length, runs: runs.length, decisions: runs.length * 91, misses: probeResults.filter(x => !x.anyExpectedFound).map(x => ({ text: x.text, want: x.want, selected: x.selected })) }));
