import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { PersonalExperiences } from '../lib/personal-experiences.mjs';

class TestStore {
  constructor(filename = ':memory:') { this.db = new DatabaseSync(filename); }
  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  close() { this.db.close(); }
}

function turn(reply, user = '你最近在读什么？', id = 'assistant-1', role = 'miyue') {
  return [
    { id: `user-${id}`, role, speaker: 'user', text: user },
    { id, role, speaker: 'assistant', text: reply },
  ];
}

test('candidate stores a fictional first-person experience and survives restart', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'personal-experiences-'));
  const filename = path.join(directory, 'life.sqlite');
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const first = new TestStore(filename);
  const repo = new PersonalExperiences(first);
  const rows = turn('我以前读过《海边的卡夫卡》，那种潮湿的梦感一直留着。');
  const saved = repo.observe('miyue', rows, { kind: 'reading', title: '海边的卡夫卡', summary: '潮湿的梦感。', evidence: '我以前读过《海边的卡夫卡》' });
  assert.equal(saved.length, 1);
  assert.equal(saved[0].source, 'fictional_conversation');
  first.close();
  const second = new TestStore(filename);
  t.after(() => second.close());
  assert.equal(new PersonalExperiences(second).list('miyue')[0].title, '海边的卡夫卡');
});

test('only evidence in the delivered assistant reply is accepted, and retries are idempotent', () => {
  const repo = new PersonalExperiences(new TestStore());
  const rows = turn('我看过《花样年华》，雨声很适合它。');
  const fallback = repo.observe('miyue', rows, { kind: 'film', title: '花样年华', summary: '雨声。', evidence: '我看过《春光乍泄》' });
  assert.equal(fallback.length, 1);
  assert.doesNotMatch(fallback[0].evidence, /春光乍泄/);
  const candidate = { kind: 'film', title: '花样年华', summary: '雨声。', evidence: '我看过《花样年华》' };
  assert.equal(repo.observe('miyue', rows, candidate).length, 1);
  assert.equal(repo.observe('miyue', rows, candidate).length, 1);
  assert.equal(repo.list('miyue').length, 1);
});

test('other roles, quoted user experience, malformed metadata, and negated plans are ignored', () => {
  const repo = new PersonalExperiences(new TestStore());
  assert.deepEqual(repo.observe('wenxi', turn('我读过《局外人》。', '你读过《局外人》吗？', 'x', 'wenxi')), []);
  assert.deepEqual(repo.observe('miyue', turn('你读过《局外人》啊，我记住了。', '我读过《局外人》。')), []);
  assert.deepEqual(repo.observe('miyue', turn('我没读过《局外人》，准备下周读。'), { kind: 'reading', title: '局外人', summary: 'x', evidence: '我没读过《局外人》' }), []);
  assert.deepEqual(repo.observe('miyue', turn('我觉得《局外人》很安静。'), { kind: 'reading', title: '局外人', summary: '', evidence: '我觉得《局外人》' }), []);
});

test('fallback captures an affirmative reply using the user title, while candidate takes precedence', () => {
  const repo = new PersonalExperiences(new TestStore());
  assert.equal(repo.observe('miyue', turn('我也读过，最喜欢它结尾的空白。', '你读过《局外人》吗？', 'fallback')).length, 1);
  assert.equal(repo.list('miyue')[0].title, '局外人');
  const candidateRows = turn('我以前看过《燃烧》，它比我记得的更慢。', '你看过《燃烧》吗？', 'candidate');
  const saved = repo.observe('miyue', candidateRows, { kind: 'film', title: '燃烧', summary: '比记忆更慢。', evidence: '我以前看过《燃烧》' });
  assert.equal(saved[0].summary, '比记忆更慢。');
});

test('daily experiences and subjectless replies to a named title are accepted without hard expression rules', () => {
  const repo = new PersonalExperiences(new TestStore());
  const daily = turn('我以前去过《旧码头》，傍晚的风很咸。', '你去过《旧码头》吗？', 'daily');
  assert.equal(repo.observe('miyue', daily, { kind: 'daily', title: '旧码头', summary: '傍晚的风很咸。', evidence: '我以前去过《旧码头》' }).length, 1);
  assert.equal(repo.observe('miyue', turn('看过，那段停顿我记得。', '你完整读过红楼梦吗？', 'bare')).at(0).title, '红楼梦');
});

test('an invalid candidate falls back to actual past evidence, while a later first-person feeling becomes the latest title state', () => {
  const repo = new PersonalExperiences(new TestStore());
  const first = turn('我读过《局外人》，那种克制我记得。', '聊聊《局外人》', 'initial');
  assert.equal(repo.observe('miyue', first, { kind: 'reading', title: '局外人', summary: '', evidence: '我读过《局外人》' }).length, 1);
  const changed = turn('我觉得《局外人》现在读起来更冷了。', '你现在怎么看《局外人》？', 'changed');
  assert.equal(repo.observe('miyue', changed, { kind: 'reading', title: '局外人', summary: '现在读起来更冷了。', evidence: '我觉得《局外人》现在读起来更冷了' }).length, 1);
  assert.equal(repo.list('miyue')[0].summary, '现在读起来更冷了。');
});

test('context favors matching titles, bounds output, and labels fictional provenance', () => {
  const repo = new PersonalExperiences(new TestStore());
  repo.observe('miyue', turn('我读过《局外人》，那种克制让我记了很久。', '聊聊《局外人》', 'one'));
  repo.observe('miyue', turn('我看过《花样年华》，走廊的光很好看。', '聊聊《花样年华》', 'two'));
  const matching = repo.context('miyue', '局外人', 600);
  assert.match(matching, /角色虚构经历/);
  assert.match(matching, /局外人/);
  assert.doesNotMatch(matching, /花样年华/);
  assert.ok(repo.context('miyue', '无关内容', 40).length <= 40);
});
