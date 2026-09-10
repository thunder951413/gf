import test from 'node:test';
import assert from 'node:assert/strict';
import { AttentionMemory } from './retrieval-v2.mjs';

const facts=()=>[
 {id:'chengdu',topic:'trip-a',text:'她已从成都回到苏州。',born:0,base:12,type:'life',keywords:['成都','苏州'],mentions:[],exposures:[]},
 {id:'hefei',topic:'trip-b',text:'合肥的行程仍在继续。',born:0,base:11,type:'life',keywords:['合肥'],mentions:[],exposures:[]},
 {id:'rare',topic:'craft',text:'记录提到一只青瓷斗笠盏，釉色偏青。',born:0,base:10,type:'source',keywords:['斗笠盏'],mentions:[],exposures:[]},
 {id:'book',topic:'reading',text:'她最近读的散文写晾衣服。',born:0,base:10,type:'life',keywords:['散文','晾衣服'],mentions:[],exposures:[]},
];

test('preserves generic Chinese names split into single characters',()=>{
 const s=new AttentionMemory({memories:facts()});
 assert.equal(s.select({text:'你还在成都吗？',day:1}).selected[0].id,'chengdu');
 assert.equal(s.select({text:'你到合肥了吗？',day:1}).selected[0].id,'hefei');
});

test('one exact rare declared keyword survives a long question',()=>{
 const s=new AttentionMemory({memories:facts()});
 assert.ok(s.select({text:'前几天你随口提到的那个东西后来怎么看，斗笠盏还喜欢吗？',day:2}).selected.some(x=>x.id==='rare'));
});

test('question punctuation splits intents and negative clause does not suppress positive clause',()=>{
 const s=new AttentionMemory({memories:facts()});
 s.observeUser({text:'先不聊成都了！你最近读的散文有什么？',day:1,turnId:'u1'});
 const r=s.select({day:1});
 assert.ok(r.selected.some(x=>x.id==='book'));assert.ok(r.selected.every(x=>x.id!=='chengdu'));
});

test('current raw user turn is excluded and questions do not outrank stored facts',()=>{
 const s=new AttentionMemory({memories:facts()});
 s.observeUser({text:'你还在成都吗？',day:1,turnId:'u1'});
 assert.equal(s.select({day:1}).selected[0].id,'chengdu');
 s.observeUser({text:'成都后来怎么样？',day:2,turnId:'u2'});
 const ids=s.select({day:2}).selected.map(x=>x.id);
 assert.equal(ids[0],'chengdu');assert.ok(!ids.includes('observed-user-1'));
});

test('substantive followup uses focus after actually supported assistant detail',()=>{
 const s=new AttentionMemory({memories:facts()});
 s.observeAssistant({text:'那篇散文确实写了晾衣服。',day:1,turnId:'a1',selectedIds:['book']});
 assert.equal(s.select({text:'嗯，接着说，我想听你自己的感受。',day:1.1}).selected[0].id,'book');
});

test('v1 invariants: future, decay, duplicate, budget, fixed seed, and input immutability',()=>{
 const input=facts();input.push({id:'future',topic:'x',text:'未来记录',born:9,base:20,type:'life',mentions:[],exposures:[]});const before=structuredClone(input);
 const s=new AttentionMemory({memories:input,halfLife:3,maxChars:20,seed:7});
 assert.ok(s.select({text:'未来记录',day:1}).selected.every(x=>x.id!=='future'));assert.equal(s.snapshot(3).memories.find(x=>x.id==='chengdu').strength,6);
 assert.ok(s.select({text:'成都',day:1,maxItems:5}).diagnostics.selectedChars<=20);assert.deepEqual(input,before);
 const run=()=>new AttentionMemory({memories:facts(),seed:99}).select({day:0,mode:'proactive',maxItems:3}).selected.map(x=>x.id);assert.deepEqual(run(),run());
});

test('true synonym gaps remain explicit rather than manually mapped',()=>{
 const s=new AttentionMemory({memories:[{id:'float',topic:'water',text:'体验是失重和漂浮。',born:0,base:10,type:'life',keywords:['失重','漂浮'],mentions:[],exposures:[]}]});
 assert.equal(s.select({text:'身体没有分量，悬在水里',day:1}).selected.length,0);
 assert.ok(s.snapshot(1).limitations.some(x=>x.includes('synonym')));
});
