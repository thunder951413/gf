import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { LifeThreadRepository, defaultLifeThreads } from '../lib/life-threads.mjs';

class TestStore {
  constructor() { this.db = new DatabaseSync(':memory:'); this.db.exec('CREATE TABLE IF NOT EXISTS messages(id TEXT PRIMARY KEY,role TEXT NOT NULL,speaker TEXT NOT NULL,text TEXT NOT NULL)'); }
  transaction(fn) { this.db.exec('BEGIN IMMEDIATE'); try { const out = fn(); this.db.exec('COMMIT'); return out; } catch (error) { this.db.exec('ROLLBACK'); throw error; } }
}
function clockAt(initial) {
  let value = new Date(initial);
  const clock = () => new Date(value);
  clock.set = next => { value = new Date(next); };
  clock.addHours = hours => { value = new Date(value.getTime() + hours * 3600_000); };
  return clock;
}
let serial = 0;
function finish(repo, clock) {
  for (;;) {
    const view = repo.get('miyue');
    const id = `m-${serial += 1}`;
    repo.store.db.prepare('INSERT INTO messages(id,role,speaker,text) VALUES(?,?,?,?)').run(id, 'miyue', 'assistant', view.beat.text);
    assert.equal(repo.markDelivered(view.pendingKey, id), true);
    clock.set(repo.get('miyue').dueAt);
    const next = repo.tick('miyue');
    if (next.id !== view.id) return next;
  }
}
const beat = id => ({ id, title: id, text: `${id} 的一步`, emotion: '平静', need: '慢慢来', facts: [`${id} 发生了`], delayHours: 12 });
const template = (id, category) => ({ id, kind: 'independent', category, title: id, initialFacts: [], beats: ['a', 'b', 'c', 'd'].map(step => beat(`${id}-${step}`)) });

test('the authored catalog covers many parts of her life with paced, participatory arcs', () => {
  const added = defaultLifeThreads.templates.filter(item => !['travel-notebook', 'design-packaging', 'hobby-collage'].includes(item.id));
  assert.ok(added.length >= 15 && added.length <= 20, String(added.length));
  const categories = new Set(added.map(item => item.category));
  for (const category of ['friend', 'family', 'client', 'purchase', 'show', 'book', 'neighbor', 'outing', 'craft', 'season', 'setback']) assert.ok(categories.has(category), category);
  assert.ok(added.filter(item => item.beats.some(step => step.choices)).length * 2 >= added.length, 'at least half let him take part');
  for (const item of defaultLifeThreads.templates) {
    assert.ok(item.category, item.id);
    const choices = item.beats.flatMap(step => step.choices || []);
    for (const choice of choices) assert.ok(choice.matchPhrases.length >= 2 && choice.matchPhrases.length <= 4, choice.id);
    const text = JSON.stringify(item);
    assert.doesNotMatch(text, /早点睡|多喝水|吃饭了吗|别熬夜|Steam|试玩|新游戏|见面|你来苏州/u, item.id);
  }
});

test('the next arc avoids the same part of her life and anything lived in the last 30 days', () => {
  const catalog = { version: 'test', templates: [template('a1', 'friend'), template('a2', 'friend'), template('b1', 'family'), template('c1', 'season')] };
  const clock = clockAt('2026-10-01T00:00:00Z');
  const repo = new LifeThreadRepository(new TestStore(), { clock, random: () => 0, catalog });
  assert.equal(repo.get('miyue').templateId, 'a1');
  let next = finish(repo, clock);
  assert.equal(next.templateId, 'b1', 'a2 is skipped right after another friend story');
  next = finish(repo, clock);
  assert.equal(next.templateId, 'a2', 'a1 was lived this month');
  next = finish(repo, clock);
  assert.equal(next.templateId, 'c1');
  clock.addHours(24 * 31);
  next = finish(repo, clock);
  assert.equal(next.templateId, 'a1', 'after a month every story is fresh again and the order resumes');
});

test('a step left unshared for a week is replaced by a fresh story from another part of her life', () => {
  const catalog = { version: 'test', templates: [template('a1', 'friend'), template('a2', 'friend'), template('b1', 'family')] };
  const clock = clockAt('2026-09-27T00:00:00Z');
  const repo = new LifeThreadRepository(new TestStore(), { clock, random: () => 0, catalog });
  const stuck = repo.get('miyue');
  assert.equal(stuck.templateId, 'a1');
  clock.addHours(24 * 6);
  assert.equal(repo.tick('miyue').id, stuck.id, 'six days is still the current story');
  clock.addHours(24);
  const fresh = repo.tick('miyue');
  assert.notEqual(fresh.id, stuck.id);
  assert.equal(fresh.templateId, 'b1', 'neither the abandoned story nor its category comes straight back');
  assert.equal(fresh.beat.id, 'b1-a');
  assert.ok(repo.pending('miyue')?.pendingKey, 'the new first step is ready to share');
});

test('a short natural reply picks a branch of a new arc', () => {
  const catalog = { version: 'test', templates: defaultLifeThreads.templates.filter(item => item.id === 'neighbor-calico-cat').concat(template('x1', 'craft'), template('x2', 'season')) };
  const clock = clockAt('2026-10-01T00:00:00Z');
  const repo = new LifeThreadRepository(new TestStore(), { clock, random: () => 0, catalog });
  const view = repo.get('miyue');
  assert.equal(view.templateId, 'neighbor-calico-cat');
  assert.equal(repo.planReply('miyue', '叫年糕吧').choiceId, 'cat-niangao');
  assert.equal(repo.planReply('miyue', '车座').choiceId, 'cat-chezuo');
  assert.equal(repo.planReply('miyue', '这猫好胖').choiceId, undefined);
});
