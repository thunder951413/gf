import test from 'node:test';
import assert from 'node:assert/strict';
import {plainSpeechIssues,continuationIssues} from '../lib/companion-style.mjs';

test('multiple decorative comparisons request revision without changing text',()=>{
  const text='你这句话像傍晚的风吹在湖面上。银杏叶落下来，像在给秋天记账。';
  assert.deepEqual(plainSpeechIssues(text,'我现在很平静呢'),['too_many_decorative_comparisons']);
});
test('literal uncertainty, a single comparison, and requested literary writing remain allowed',()=>{
  for(const text of ['好像改到第三稿了，我还想把字放大一些。','你说潜水像飞，我挺好奇身体会不会很轻。','这个方案像上一版，另一个像参考图。'])assert.deepEqual(plainSpeechIssues(text),[]);
  assert.deepEqual(plainSpeechIssues('像风吹过湖面。像月光落在窗前。','用两个比喻写一段诗'),[]);
  assert.equal(plainSpeechIssues('像风吹过湖面。像月光落在窗前。','不要再用这么多比喻').length,1);
});
test('consecutive imagery and personification also trigger the bounded revision hint',()=>{
  assert.equal(plainSpeechIssues('海面下像倒悬的天空。你像一只慢慢扇翅膀的鸟。').length,1);
  assert.equal(plainSpeechIssues('日子自己记得。河水和屋檐替他们留着痕迹。').length,1);
  assert.equal(plainSpeechIssues('像月光落到窗前。','今天很平静',['像风吹在湖面上。']).length,1);
});

test('an active conversation is not postponed until after a trip, but explicit departures are respected',()=>{
 assert.deepEqual(continuationIssues('等你回来再把那一秒讲给我听。',{holdsTopic:true},'身体悬着很轻'),['premature_topic_closing']);
 assert.deepEqual(continuationIssues('等你回来再说。',{holdsTopic:true},'我先忙，回来再聊'),[]);
 assert.deepEqual(continuationIssues('等你说到鱼群时我再想象。',{holdsTopic:true}),[]);
});
