import test from 'node:test';
import assert from 'node:assert/strict';
import { understandTurn, understandingContext } from '../lib/conversation-understanding.mjs';
import { companionIntent } from '../lib/companion-behavior.mjs';

test('gentle imagination is not a claim of physical presence, and quoted material is not an invitation',()=>{
  for(const text of ['梦里有你的体香，哈哈哈哈。','我就瘫着想怎么抱着亲你呢。','比如你会想怎么靠近我。','就像是我第一次抱着你亲你吗，哈哈哈哈']){
    const frame=understandTurn(text);assert.equal(frame.kind,'imagined_closeness',text);
    assert.equal(frame.reality,'imagined');assert.equal(companionIntent(text).affection,true);
  }
  for(const text of ['文章里写“梦里有你的体香”，是什么意思？','文章里写"梦里有你的体香"，是什么意思？','不要亲我，保持距离。','我刚做了按摩，还挺舒服的。'])assert.equal(understandTurn(text).romanticImagination,false,text);
});

test('a response to the previous invitation keeps its meaning without carrying it into unrelated updates',()=>{
  const history=[{speaker:'user',text:'梦里有你的体香，哈哈。'},{speaker:'assistant',text:'你闻过吗？'}];
  const before=structuredClone(history);
  const frame=understandTurn('你还真是不愿意满足我的小心愿呢',history);
  assert.equal(frame.kind,'imagined_closeness');assert.equal(frame.correction,true);
  assert.equal(understandTurn('我现在进安检了',history).kind,'open');
  assert.deepEqual(history,before);
});

test('reflection, correction and explicit help remain distinguishable without inventing motives',()=>{
  assert.equal(understandTurn('人和人之间有误解要解释，是为了让对方知道自己讲道理。').kind,'reflection');
  assert.equal(understandTurn('我觉得有时解释不是争输赢，是想把一个意思说清楚。').kind,'reflection');
  assert.equal(understandTurn('我是顺着前面说的，不是在说我遇到了误会。').kind,'correction');
  assert.equal(understandTurn('我刚才跟朋友吵了架').kind,'open');
  assert.equal(understandTurn('这件事该怎么处理？').adviceRequested,true);
  assert.equal(understandTurn('明天想安排半天逛苏州园林，给我一点选择路线的建议吧。').adviceRequested,true);
  assert.equal(understandTurn('要是今晚能坐在你旁边，我想握着你的手。').romanticImagination,true);
  assert.equal(understandTurn('为什么叫骑楼？').adviceRequested,false);
  assert.match(understandingContext(understandTurn('我想知道你自己的感受和念头')),/你的内心/);
});

test('correction context treats a check as a request without presuming prior fault',()=>{
  const checked=understandingContext({kind:'correction',correction:true});
  assert.match(checked,/待回应的请求，不是已证实的上一轮错误/);
  assert.match(checked,/当前原话和所给记录/);
  assert.match(checked,/个人事实以最新说法为准，已有错误则直接更正/);
  assert.doesNotMatch(checked,/修正答非所问|用户正在纠正你刚才的理解/);
  const mixed=understandingContext({kind:'help',correction:true});
  assert.match(mixed,/待回应的请求，不是已证实的答偏/);
  assert.match(mixed,/个人事实以最新说法为准，已有错误则直接更正/);
  assert.doesNotMatch(mixed,/刚才推开|修正答非所问/);
});
