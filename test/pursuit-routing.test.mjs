import test from 'node:test';import assert from 'node:assert/strict';import {articlePursuit,routePursuit} from '../lib/pursuit-routing.mjs';
test('article adaptation is bounded and selected only with a meaningful local abstract',()=>{
 assert.equal(articlePursuit([{id:'short',title:'科学',summary:'太短',url:'https://example.test'}]),null);
 const item=articlePursuit([{id:'long',title:'设计'.repeat(65),summary:'文化设计'.repeat(400),url:'https://example.test/science',source:'科学来源'}]);
 assert.ok(item.aliases[0].length<=100);assert.ok(item.stages.every(s=>Buffer.byteLength(s.detail)<=2048));assert.equal(item.source.url,'https://example.test/science');assert.equal(articlePursuit([{id:'long',title:'科学',summary:'科学'.repeat(200),url:'https://example.test'}],'long'),null);
});
test('explicit closeness does not accidentally route moon metaphor to science',()=>{
 const article={kind:'article',aliases:['月球','月食'],pendingKey:'pending'};
 assert.equal(routePursuit(article,'你愿意做我的月球吗？').introduce,false);
 assert.equal(routePursuit(article,'月食是怎么回事？').detailed,true);
});
test('new articles follow her interests, not the newest unrelated headline',()=>{
 const previous={id:'old',title:'上次的设计笔记',interests:['包装','摄影']};
 const items=[{id:'hot',title:'热点科学大新闻',summary:'知识文化'.repeat(100),url:'https://example.test/hot'},{id:'fit',title:'摄影里的构图',summary:'摄影观察'.repeat(100),url:'https://example.test/fit'}];
 assert.equal(articlePursuit(items,previous).id,'fit');
 assert.match(articlePursuit(items,previous).origin,/包装/);
 assert.equal(articlePursuit(items,previous,['fit']),null);
});
test('a question about a completed experience does not start the current pending item',()=>{
 const p={id:'current',kind:'film',aliases:['十二怒汉'],pendingKey:'new',completed:[{id:'past',kind:'reading',aliases:['百草园']}]};
 const r=routePursuit(p,'你还记得百草园里那个细节吗？');
 assert.equal(r.detailed,true);assert.equal(r.historical,true);assert.equal(r.introduce,false);assert.equal(r.sourceKind,'reading');
});
