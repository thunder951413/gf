import test from 'node:test';
import assert from 'node:assert/strict';
import {plainSpeechIssues,continuationIssues,spokenChatGuidance,STAGED_REACTION_NARRATION_REVISION} from '../lib/companion-style.mjs';

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

test('staged reaction narration gets one targeted spoken-style issue',()=>{
  const quotedBadCase='你这句话一出来，我先是没接住，脸侧过去了一下。从后面抱，我大概会先往前小小挪半步，然后又退回来——反正躲不掉。';
  assert.deepEqual(plainSpeechIssues(quotedBadCase),['staged_reaction_narration']);
  assert.deepEqual(plainSpeechIssues('你一碰我，我先愣住，眼神飘开，手指攥了一下，又往后退了半步。'),['staged_reaction_narration']);
  assert.deepEqual(plainSpeechIssues('听到这句我心里一紧，先把脸埋进枕头，过一会儿抬眼看你，手又悄悄缩回去。'),['staged_reaction_narration']);
  assert.match(STAGED_REACTION_NARRATION_REVISION,/聊天口吻/);
});

test('spoken feelings, ordinary actions, and explicitly staged writing remain allowed',()=>{
  for (const text of ['你这么一说，我都羞得不知道往哪看。你抱我我就靠着你，反正也没想跑。','我有点害羞，但还是想听你多说点。','我先洗菜然后炒饭。','我把杯子递给你。']) assert.deepEqual(plainSpeechIssues(text),[]);
  assert.deepEqual(plainSpeechIssues('舞者先把脸侧过去，随后抬眼，手又收回来。','给我写一段双人舞的走位和动作。'),[]);
  assert.deepEqual(plainSpeechIssues('“你一碰我，我先愣住，眼神飘开，手指攥了一下，又往后退了半步。”为什么这段话显得做作？','为什么这段话显得做作？'),[]);
  assert.deepEqual(plainSpeechIssues('我羞得不太会说话，但听见你这么讲，心里还是很软。','请详细描写她的感受，但保持聊天语气。'),[]);
});

test('spoken chat guidance is stable and follows the same explicit-creative scope',()=>{
  assert.match(spokenChatGuidance(),/直接说感受、想法或想做什么/);
  assert.match(spokenChatGuidance(),/固定的害羞或脸红开场/);
  assert.equal(spokenChatGuidance('写一段诗意的小说场景'),'');
  assert.notEqual(spokenChatGuidance('别写得太诗意，详细描写她的感受'),'');
});

test('an active conversation is not postponed until after a trip, but explicit departures are respected',()=>{
 assert.deepEqual(continuationIssues('等你回来再把那一秒讲给我听。',{holdsTopic:true},'身体悬着很轻'),['premature_topic_closing']);
 assert.deepEqual(continuationIssues('等你回来再说。',{holdsTopic:true},'我先忙，回来再聊'),[]);
 assert.deepEqual(continuationIssues('等你说到鱼群时我再想象。',{holdsTopic:true}),[]);
});

test('continuation checking respects the resolved closing decision in both directions',()=>{
 assert.deepEqual(continuationIssues('等你回来再聊。',{holdsTopic:true},'晚点我再说后面怎么样。',{allowClosing:true}),[]);
 assert.deepEqual(continuationIssues('等你回来再聊。',{holdsTopic:true},'电影最后一句是晚安',{allowClosing:false}),['premature_topic_closing']);
});


test('dense staged reactions get revised while a direct wish with one action remains intact',()=>{
 assert.ok(plainSpeechIssues('你从后面圈过来，我就往后靠，后背贴着你，手搭在你小臂上。脖子一热先缩一下肩，然后又松下来。耳朵肯定藏不住，最后闭着眼，把手往你手背上收一收。').includes('staged_reaction_narration'));
 assert.deepEqual(plainSpeechIssues('你抱我我就靠着你，反正也没想跑。是真的想多待一会儿，平时一个人在家，总觉得少个人说话。'),[]);
});

test('ordinary relaxation instructions are not an acted emotional response',()=>{
 assert.deepEqual(plainSpeechIssues('闭着眼，肩慢慢松下来，往后靠一下，把手慢慢收回，结束这组拉伸。'),[]);
});
