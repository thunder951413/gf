import test from 'node:test';import assert from 'node:assert/strict';
import{normalizeReplyPresentation as normalize}from'../lib/reply-presentation.mjs';
test('presentation labels are removed without changing prose, URLs, questions, or paragraph structure',()=>{
 const body='报道没有提供剧情。\n\n他认错人，你跟不跟？跟了可能走偏。\n出处：https://example.test/a?q=1';
 const result=normalize('【历史消息·2026-09-15 18:00】\n'+body);
 assert.equal(result.reply,body);assert.deepEqual(result.repairs,['removed_history_timestamp']);
 assert.deepEqual(normalize(result.reply),{reply:body,repairs:[]});
 assert.equal(normalize('第一段。\n\n【2026-09-10 16:11】第二段。').reply,'第一段。\n\n第二段。');
 assert.deepEqual(normalize('【本轮回复】\n【历史消息·2026-09-15 18:00】正文。'),{reply:'正文。',repairs:['removed_reply_label','removed_history_timestamp']});
});
test('quoted, inline, fenced and indented literal labels survive and following prose still normalizes',()=>{
 const label='【历史消息·2026-09-15 18:00】';
 for(const text of [`“${label}”是时间标签。`,`她写着：\n“\n${label}\n”\n正文。`,`\`${label}\``,`\`跨行\n${label}\n\``,`> ${label}`,`    ${label}\n正文。`,`\t${label}`,`~~~text\n${label}\n~~~`,`\`\`\`text\n${label}\n\`\`\``]){
  assert.deepEqual(normalize(text),{reply:text,repairs:[]},text);
 }
 const code='```text\n'+label+'\n```\n';
 assert.equal(normalize(code+label+'正文。').reply,code+'正文。');
 assert.equal(normalize('她看到'+label+'时停下了。').reply,'她看到'+label+'时停下了。');
});
test('literal-output intent protects labels and presentation pass never edits substantive content',()=>{
 const text='【2026-09-15 18:00】发布尚未确认，你还记得吗？';
 for(const currentText of ['请原样输出这段内容','请解释时间标签的用法','给我一段日志示例','帮我检查代码'])assert.deepEqual(normalize(text,{currentText}),{reply:text,repairs:[]});
 assert.deepEqual(normalize(text,{preservePresentation:true}),{reply:text,repairs:[]});
 const prose='你先忙你的。你应该休息。你心里其实很难过。';
 assert.deepEqual(normalize(prose),{reply:prose,repairs:[]},'presentation must not run style/semantic filters');
 assert.equal(normalize('【本轮回复】').reply,'','empty draft remains empty, no invented fallback');
});

test('a requested standalone date is an answer, while a decoration-only chat draft stays empty',()=>{
 const value='【2026-09-15 18:00】';
 assert.deepEqual(normalize(value,{currentText:'现在几点？'}),{reply:value,repairs:[]});
 assert.equal(normalize(value,{currentText:'聊聊今天的小事'}).reply,'');
});
