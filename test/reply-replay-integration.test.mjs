import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {createApp} from '../server.mjs';import {SYSTEM_PROMPT} from '../lib/semantic-planner.mjs';
const now='2026-09-16T02:23:42Z';
async function fixture(t,{text,seeds,drafts}){
 const dataDir=fs.mkdtempSync(path.join(os.tmpdir(),'reply-replay-'));let calls=0;
 const app=await createApp({dataDir,initialFeeds:[],semanticUnderstanding:true,dialogueMemory:true,turnReaction:false,materialPresentation:'generated',clock:()=>new Date(now),
 startWeixin:false,startChatQueue:false,startProactive:false,startRecall:false,startResearch:false,startRuntime:false,startDossiers:false,startPursuits:false,startLife:false,startLifeThreads:false,
 replySleep:async()=>{},env:{LIFE_MODEL_BASE_URL:'https://fixture.test/v1',LIFE_MODEL_NAME:'fixture'},fetchImpl:async(_url,init)=>{
 const b=JSON.parse(init.body);const raw=b.messages[0].content===SYSTEM_PROMPT||b.messages[0].content.startsWith('Classify the current Chinese companion-dialogue turn.')?
 {intent:'ask_question',continuity:'continue',focusMessageId:'r1',ownLife:false,advice:false,emotionalDetail:false,imagined:false,correction:false,acceptsOffer:false,source:'none',retrievalQuery:'',evidence:text}:
 {reply:drafts[Math.min(calls++,drafts.length-1)],extra:''};
 return Response.json({choices:[{message:{content:JSON.stringify(raw)}}]});}});
 app.preferences.setReplyPace('instant');for(const seed of seeds){const rows=app.store.saveChatTurn({role:'miyue',text:seed.user,reply:seed.reply});for(const row of rows)app.store.db.prepare('UPDATE messages SET created_at=? WHERE id=?').run(seed.at||'2026-09-15T13:56:19Z',row.id);}
 const {port}=await app.listen(0);t.after(async()=>{await app.close();fs.rmSync(dataDir,{recursive:true,force:true});});
 const response=await fetch(`http://127.0.0.1:${port}/api/chat`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({role:'miyue',text})});
 return {app,calls,status:response.status,result:await response.json()};
}
const old='水流、风、阳光也会动，也会变，可你盯着看久了，知道它下一秒大概还是这样；活物不一样，它有自己的意思——猫会挑地方趴，植物会朝着光那边歪，你没法完全猜到它想干嘛。那点猜不到，大概就是你说的灵魂。';
test('HTTP continuation repairs a replay older than six hours while retaining the original history',async t=>{
 const reply='我没想到你会把问题转到自己身上。有时猜你会开个玩笑，你却很认真，这点倒是挺有意思的。';
 const f=await fixture(t,{text:'那你觉得我会按照你的预期来么',seeds:[{user:'活物总让人觉得有灵魂。',reply:old}],drafts:[old+'你问这个问题本身已经不太按预期了。',reply]});
 assert.equal(f.status,200,JSON.stringify(f.result));assert.equal(f.calls,2);
 assert.equal(f.app.store.getMessages('miyue')[1].text,old);
 assert.equal(f.result.messages.at(-1).text.replace(/\s/g,''),reply);
 assert.ok(f.app.dialogueTraces.list()[0].repairIssues.includes('verbatim_reply_replay'));
});
test('HTTP continuation repairs copying the current user as the character without changing the user message',async t=>{
 const text='我替妹妹保管的书签已经还给她了，现在不用一直惦记这件事了';
 const reply='她拿回去，你也放心啦。替别人保管东西，反而比自己的更怕弄丢。';
 const f=await fixture(t,{text,seeds:[{user:'我替妹妹保管书签。',reply:'她拿回来就放心了。'}],drafts:[text+'。我可算放心了。',reply]});
 assert.equal(f.status,200,JSON.stringify(f.result));assert.equal(f.calls,2);
 assert.equal(f.result.messages.find(r=>r.speaker==='user').text,text);
 assert.equal(f.result.messages.at(-1).text.replace(/\s/g,''),reply);
 assert.ok(f.app.dialogueTraces.list()[0].repairIssues.includes('copied_user_utterance'));
});
