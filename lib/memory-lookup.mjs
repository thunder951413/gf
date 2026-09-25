import { isRecallRequest } from './conversation-act.mjs';

const relativeDay = new Map([['前天', -2], ['昨天', -1], ['今天', 0], ['明天', 1], ['后天', 2]]);
const weekdays = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];
const beijingParts = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});
const chineseWords = new Intl.Segmenter('zh-CN', { granularity: 'word' });
const queryStopWords = new Set([
  '我', '你', '他', '她', '它', '我们', '你们', '他们', '记得', '还', '怎么', '哪个', '什么', '哪里', '哪儿', '什么时候', '来着',
  '今天', '明天', '后天', '昨天', '前天', '周末', '星期', '周一', '周二', '周三', '周四', '周五', '周六', '周日', '周天', '礼拜',
]);

function contentTerms(text) {
 return new Set([...chineseWords.segment(String(text ?? ''))]
  .filter(part => part.isWordLike)
  .map(part => part.segment.toLowerCase())
  .filter(term => term.length >= 2 && !queryStopWords.has(term)));
}

function beijingCalendar(value) {
 const date = new Date(value);
 if (!Number.isFinite(+date)) return null;
 const parts = Object.fromEntries(beijingParts.formatToParts(date).map(part => [part.type, part.value]));
 return { year: Number(parts.year), month: Number(parts.month), day: Number(parts.day), hour: parts.hour, minute: parts.minute };
}

function formatCalendarDay(value) {
 const date = new Date(Date.UTC(value.year, value.month - 1, value.day));
 return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}（${weekdays[date.getUTCDay()]}）`;
}

// The annotation is mechanical evidence about the date a relative word meant
// when it was written. It never infers an itinerary, booking, or transport.
export function relativeDateAnnotations(text, createdAt) {
 const terms = [...new Set(String(text ?? '').match(/今天|明天|后天|昨天|前天/gu) || [])];
 if (!terms.length) return [];
 const calendar = beijingCalendar(createdAt);
 if (!calendar) return [];
 return terms.map(term => {
  const date = new Date(Date.UTC(calendar.year, calendar.month - 1, calendar.day + relativeDay.get(term)));
  const target = { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
  return `原话中的“${term}”按该消息北京时间 ${calendar.year}-${String(calendar.month).padStart(2, '0')}-${String(calendar.day).padStart(2, '0')} ${calendar.hour}:${calendar.minute} 对应 ${formatCalendarDay(target)}`;
 });
}

function currentWeekdayReference(text, now) {
 if (!/(?:周|星期|礼拜)[一二三四五六日天]/u.test(String(text))) return '';
 const calendar = beijingCalendar(now);
 return calendar ? `【本轮日期定位】当前北京时间为 ${formatCalendarDay(calendar)}。` : '';
}

// Explicit recall is a read-only lookup of actual user messages, independent of
// the conversational callback cooldown and without an extra model request.
export function lookupUserEvidence(store,episodes,scope,text,{limit=3,charBudget=700,now=new Date()}={}){
 const practicalRecall=/(?:哪个|哪趟|哪班).{0,12}来着/u.test(String(text));
 if(!isRecallRequest(text)&&!practicalRecall)return{rows:[],context:''};
 const query=contentTerms(text);
 const suppressed=new Set(episodes.suppressedSourceIds(scope));
 const rows=store.db.prepare("SELECT id,text,created_at FROM recall_messages WHERE role=? AND speaker='user' ORDER BY rowid DESC LIMIT 1000").all(scope).filter(r=>!suppressed.has(r.id));
 const frequency=new Map([...query].map(token=>[token,rows.filter(r=>r.text.includes(token)).length]));
 const ranked=rows.map((r,index)=>{let score=0;for(const token of query)if(r.text.includes(token))score+=1/Math.sqrt(frequency.get(token));if(/城市|我在哪|住哪/.test(text)&&/我(?:现在)?(?:在|住在|住)|我这边是/.test(r.text))score+=1;return{...r,index,score};}).filter(r=>r.score>0).sort((a,b)=>b.score-a.score||a.index-b.index);
 const selected=[];let used=0;for(const r of ranked){if(selected.length>=limit)break;const annotations=relativeDateAnnotations(r.text,r.created_at);const line=`用户原话（${r.created_at}，消息${r.id}）：${r.text}${annotations.length?'\n'+annotations.join('；'):''}`;if(used+line.length>charBudget)continue;selected.push({...r,line});used+=line.length;}
 const currentReference=currentWeekdayReference(text,now);
 const header='【本轮按用户请求核对的历史原话】';
 const footer='只回答原话实际包含的内容；缺项说没找到，不把核对记忆解释成考验或害怕被忘记。';
 return{rows:selected.map(({id,text,created_at})=>({id,text,createdAt:created_at})),context:selected.length?`${header}\n${[currentReference,...selected.map(r=>r.line)].filter(Boolean).join('\n')}\n${footer}`:`${header}\n${[currentReference,'没有查到与当前问题匹配的用户原话；不要补全未记录的事项。'].filter(Boolean).join('\n')}\n${footer}`};
}
