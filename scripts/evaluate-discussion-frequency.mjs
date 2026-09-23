import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DiscussionTopics } from '../lib/discussion-topics.mjs';
import catalog from '../app-data/discussion-topics.json' with { type: 'json' };

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_OUTPUT = path.join(ROOT, '.runtime', 'discussion-topics', 'frequency.json');
const TARGET_CATEGORY = 'psychology';
const TARGET_TOPIC = 'memory-reconstruction';
const LAST_CATEGORY_TOPIC = 'routes-and-terrain';

class TemporaryStore {
  constructor() {
    this.db = new DatabaseSync(':memory:');
    this.db.exec(`PRAGMA foreign_keys=ON; CREATE TABLE messages(
      id TEXT PRIMARY KEY,role TEXT NOT NULL,speaker TEXT NOT NULL,text TEXT NOT NULL,
      kind TEXT NOT NULL,created_at TEXT NOT NULL)`);
    this.depth = 0;
  }
  getMessage(id) {
    const row = this.db.prepare('SELECT * FROM messages WHERE id=?').get(id);
    return row && { id:row.id,role:row.role,speaker:row.speaker,text:row.text,kind:row.kind,createdAt:row.created_at };
  }
  transaction(fn) {
    const savepoint = `frequency_${this.depth}`;
    this.db.exec(this.depth ? `SAVEPOINT ${savepoint}` : 'BEGIN');
    this.depth += 1;
    try { const result=fn(); this.depth-=1; this.db.exec(this.depth ? `RELEASE ${savepoint}` : 'COMMIT'); return result; }
    catch(error) { this.depth-=1; this.db.exec(this.depth ? `ROLLBACK TO ${savepoint}; RELEASE ${savepoint}` : 'ROLLBACK'); throw error; }
  }
  close() { this.db.close(); }
}

function seeded(seed) {
  let state = Number(seed) >>> 0;
  return () => { state = (state * 1664525 + 1013904223) >>> 0; return state / 2 ** 32; };
}

function scenario({ state, samples, seed }) {
  const store = new TemporaryStore();
  let now = new Date('2026-09-01T10:00:00.000Z'), sequence = 0;
  const save = (speaker, text, kind = 'chat') => {
    const id = `m${++sequence}`;
    store.db.prepare('INSERT INTO messages VALUES(?,?,?,?,?,?)').run(id, 'miyue', speaker, text, kind, now.toISOString());
    return store.getMessage(id);
  };
  const repo = new DiscussionTopics(store, { catalog, clock:()=>now, random:seeded(seed) });
  try {
    const opening = save('assistant', '我想到一个关于记忆变化的心理学问题，想听听你的看法。');
    const exposure = repo.recordDelivery({ topicId:TARGET_TOPIC, messageId:opening.id, trigger:'autonomous', quote:opening.text });
    if (!exposure) throw new Error('failed to seed target exposure');
    if (state) {
      const wording = {
        wants_more:'心理学以后可以多聊一点',
        less:'心理学以后少聊一点',
        blocked:'以后不要主动聊心理学了',
      }[state];
      const response = save('user', wording);
      const recorded = repo.observeResponse({ roleId:'miyue', messageId:response.id, exposureId:exposure.id, signal:{ state, scope:'category', evidence:wording } });
      if (!recorded) throw new Error(`failed to seed ${state} response`);
    }
    // The target exposure is older than seven days. A recent geography
    // opening is identical in all variants and makes geography, rather than
    // psychology, the last category. This isolates feedback weighting from
    // cooldown and consecutive-category suppression.
    now = new Date('2026-09-15T10:00:00.000Z');
    const recent = save('assistant', '最近看地图时，我在想道路为什么总从某些地方经过。');
    if (!repo.recordDelivery({ topicId:LAST_CATEGORY_TOPIC, messageId:recent.id, trigger:'autonomous', quote:recent.text })) throw new Error('failed to seed recent exposure');
    now = new Date('2026-09-16T10:00:00.000Z');
    const byCategory = {}, byTopic = {};
    for (let index=0; index<samples; index+=1) {
      const selected = repo.choose({ roleId:'miyue' });
      if (!selected) continue;
      byCategory[selected.category] = (byCategory[selected.category] || 0) + 1;
      byTopic[selected.id] = (byTopic[selected.id] || 0) + 1;
    }
    const selectedTotal = Object.values(byCategory).reduce((sum,count)=>sum+count,0);
    const shares = Object.fromEntries(Object.keys(byCategory).sort().map(category=>[category,Number((byCategory[category]/samples).toFixed(6))]));
    return { state:state || 'no_feedback', samples, selectedTotal, targetCategory:TARGET_CATEGORY, targetSelections:byCategory[TARGET_CATEGORY]||0, targetOpportunityShare:Number(((byCategory[TARGET_CATEGORY]||0)/samples).toFixed(6)), categoryOpportunityShares:shares, topicSelections:byTopic };
  } finally { store.close(); }
}

export function runExperiment({ samples=10_000, seed=951413 }={}) {
  const count = Math.max(100, Math.trunc(Number(samples) || 10_000)), baseSeed = Number(seed) >>> 0;
  const variants = Object.fromEntries([null,'wants_more','less','blocked'].map(state=>{
    const result=scenario({state,samples:count,seed:baseSeed});return[result.state,result];
  }));
  const checks = {
    wantsMoreRaisesTargetOpportunity: variants.wants_more.targetOpportunityShare > variants.no_feedback.targetOpportunityShare,
    lessLowersTargetOpportunity: variants.less.targetOpportunityShare < variants.no_feedback.targetOpportunityShare,
    blockedRemovesTargetOpportunity: variants.blocked.targetOpportunityShare === 0,
    blockedKeepsOtherFieldsAvailable: Object.entries(variants.blocked.categoryOpportunityShares).some(([category,share])=>category!==TARGET_CATEGORY&&share>0),
  };
  return {
    experiment:'discussion_topic_selection_opportunities', version:1, seed:baseSeed, samplesPerVariant:count,
    metric:'choose() selection opportunity share',
    interpretation:'This measures offline topic-selection opportunities under identical synthetic history. It is not message sending frequency, conversation naturalness, or user satisfaction.',
    controls:{targetCategory:TARGET_CATEGORY,targetExposureAt:'2026-09-01T10:00:00.000Z',lastCategory:'geography',lastExposureAt:'2026-09-15T10:00:00.000Z',sampledAt:'2026-09-16T10:00:00.000Z',cooldownConfound:'target exposure is older than 7 days'},
    variants, checks, passed:Object.values(checks).every(Boolean),
  };
}

function parseArgs(argv) {
  const options={};
  for(let i=0;i<argv.length;i+=1){if(argv[i]==='--samples')options.samples=Number(argv[++i]);else if(argv[i]==='--seed')options.seed=Number(argv[++i]);else if(argv[i]==='--output')options.output=path.resolve(argv[++i]);}
  return options;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const { output=DEFAULT_OUTPUT, ...options } = parseArgs(process.argv.slice(2)), result=runExperiment(options);
  fs.mkdirSync(path.dirname(output),{recursive:true});fs.writeFileSync(output,`${JSON.stringify(result,null,2)}\n`);
  console.log(JSON.stringify(result,null,2));
  if(!result.passed)process.exitCode=1;
}
