import { writeFile } from 'node:fs/promises';
import { relationshipEvents, projectionOptions } from './fixtures.mjs';
import { projectRelationship, relationshipContext } from './relationship-projection.mjs';

const snapshots = [
  ['After early warmth and day-one message burst', '2026-08-01T23:59:59Z'],
  ['While temporary and persistent boundaries are both active', '2026-08-07T20:00:00Z'],
  ['After a week of shared threads, boundary, correction, and missed promise', '2026-08-10T00:00:00Z'],
  ['After no-contact absence, re-entry, forget request, and role-isolation probes', projectionOptions.asOf],
];

const blocks = snapshots.map(([title, asOf]) => {
  const projected = projectRelationship(relationshipEvents, { ...projectionOptions, asOf });
  return `## ${title}\n\nAs of: ${asOf}\n\n\`\`\`text\n${relationshipContext(projected)}\n\`\`\``;
});

const output = `# Synthetic relationship-projection output\n\nThis is deterministic fixture output from a pure projection prototype. It is not a transcript, model evaluation, production result, or claim about actual companion quality.\n\n${blocks.join('\n\n')}`;
const target = new URL('./SYNTHETIC-OUTPUT.md', import.meta.url);
await writeFile(target, `${output}\n`, 'utf8');
console.log(output);
