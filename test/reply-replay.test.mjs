import test from 'node:test';
import assert from 'node:assert/strict';
import {replyReplayPlan,replyReplayIssues} from '../lib/reply-replay.mjs';
import {replyNoveltyPlan,replyNoveltyIssues} from '../lib/reply-novelty.mjs';
const now=new Date('2026-09-16T02:23:42Z');
const old='水流、风、阳光也会动，也会变，可你盯着看久了，知道它下一秒大概还是这样。活物不一样，它有自己的意思，猫会挑地方趴，植物会朝着光那边歪，你没法完全猜到它想干嘛。那点猜不到，大概就是你说的灵魂。';
const conversation=[{speaker:'assistant',text:old,createdAt:'2026-09-15T13:56:19Z'}];
test('continuation cannot exempt yesterday’s substantial verbatim replay',()=>{
 const plan=replyNoveltyPlan({now,userText:'那你觉得我会按照你的预期来么',conversation});plan.reviewing=true;
 assert.deepEqual(replyNoveltyIssues(old+'你问我这个问题本身，就已经不太按预期来了。',plan),['verbatim_reply_replay']);
 assert.deepEqual(replyNoveltyIssues('我猜得到你会接着聊，却没猜到你会把问题转到自己身上。',plan),[]);
});
test('copied user opening is a perspective warning even when semantic routing says continue',()=>{
 const userText='我替妹妹保管的书签已经还给她了，现在不用一直惦记这件事了';
 const plan=replyNoveltyPlan({now,userText,conversation:[]});plan.reviewing=true;
 assert.deepEqual(replyNoveltyIssues(userText+'。她拿回去就好。',plan),['copied_user_utterance']);
 assert.deepEqual(replyNoveltyIssues('她已经拿回去，你也不用再惦记啦。',plan),[]);
});
test('explicit quotations and transformation requests remain available',()=>{
 for(const userText of ['把刚才的话原样再说一遍','总结一下我们之前讨论的内容','把这段翻译一下']){
  assert.deepEqual(replyReplayIssues(old,replyReplayPlan({now,userText,conversation})),[]);
 }
 const plan=replyReplayPlan({now,conversation});
 for(const quoted of ['“'+old+'”','“开头\n'+old+'\n结束”','```\n'+old+'\n```','> '+old])assert.deepEqual(replyReplayIssues(quoted,plan),[]);
});
test('short social echoes, factual followups and changed details do not become verbatim replays',()=>{
 assert.deepEqual(replyReplayIssues('我也想你。',replyReplayPlan({now,userText:'我也想你'})),[]);
 const single=old.split('。')[0]+'。';assert.deepEqual(replyReplayIssues(single,replyReplayPlan({now,conversation})),[]);
 assert.deepEqual(replyReplayIssues('原来还剩三页，现在已经全部改完了。',replyReplayPlan({now,conversation:[{speaker:'assistant',text:'原来还剩两页，现在还没有改完。'}]})),[]);
});
test('only the character history in the bounded past participates',()=>{
 for(const row of [{speaker:'user',text:old},{speaker:'assistant',text:old,createdAt:'2026-09-01T00:00:00Z'},{speaker:'assistant',text:old,createdAt:'2026-09-17T00:00:00Z'}]){
  assert.deepEqual(replyReplayIssues(old,replyReplayPlan({now,conversation:[row]})),[]);
 }
});
test('asking not to repeat is not permission for verbatim replay',()=>{
 const plan=replyReplayPlan({now,userText:'不要复述前面的回答，直接聊你现在的想法',conversation});
 assert.equal(plan.allowLiteral,false);assert.deepEqual(replyReplayIssues(old,plan),['verbatim_reply_replay']);
});
