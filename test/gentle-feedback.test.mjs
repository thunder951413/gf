import test from 'node:test';import assert from 'node:assert/strict';import {DatabaseSync} from 'node:sqlite';import {GentleFeedbackRepository} from '../lib/gentle-feedback.mjs';
test('gentle feedback is specific, infrequent, role scoped, and not triggered by ordinary pride or quoted reflection',t=>{
 const store={db:new DatabaseSync(':memory:')};t.after(()=>store.db.close());let at=new Date('2026-09-07T02:00:00Z');const repo=new GentleFeedbackRepository(store,{clock:()=>at});
 for(const text of ['我觉得这次做得挺好','我不赞同你的看法','他说“你只管听我的”，我该怎么回答','这样说是不是有点过分'])assert.equal(repo.plan('miyue',text).offer,false);
 const plan=repo.plan('miyue','你只管听我的，我替你决定。');assert.equal(plan.offer,true);assert.match(plan.context,/提醒部分最多一句、不超过45字/);repo.commit(plan);
 assert.equal(repo.plan('miyue','你只管听我的').offer,false);assert.equal(repo.plan('wenxi','你只管听我的').offer,true);
 at=new Date(+at+7*3600000);assert.equal(repo.plan('miyue','你只管听我的').offer,false);
 for(let i=0;i<6;i++)repo.commit(repo.plan('miyue','聊点别的'));
 assert.equal(new GentleFeedbackRepository(store,{clock:()=>at}).plan('miyue','你只管听我的').offer,true);
});
