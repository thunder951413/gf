const clip = (value, limit) => String(value ?? '').trim().slice(0, limit);
const invalid = message => Object.assign(new Error(message), {code:'INVALID_PROACTIVE_MATERIAL'});

// Providers retain their own progress. This slate offers evidence without
// advancing a book, consuming a topic, or inventing an experience.
export function proactiveMaterialSlate({articles = [], pursuit = null, discussion = null, thread = null, recent = []} = {}) {
  const items = articles.slice(0, 3).map(article => ({
    id:`source:${article.id}`, kind:'article', title:clip(article.title, 200), contentId:article.id,
    detail:clip(article.summary, 1000), source:{title:article.source, url:article.url, publishedAt:article.publishedAt},
    scope:'公开订阅摘要；时间以原始发布时间为准，未提供全文。',
  }));
  if (pursuit?.pendingKey && pursuit.readable !== false) items.push({
    id:pursuit.pendingKey, kind:pursuit.kind === 'film' ? 'film' : 'reading', title:clip(pursuit.title, 200),
    detail:clip(pursuit.stage?.detail, 1500), stage:clip(pursuit.stage?.label, 160),
    source:pursuit.source, version:pursuit.version,
    scope:'角色已到达的阅读或观影阶段；只讨论当前阶段，不提前讲未读的后续，也不声称此刻仍在读。文章笔记不等于最新新闻，不能推断为今天刚发生。',
  });
  // Her own multi-day personal project (a life thread). Only the current step
  // is offered; once she tells it, the thread can move on to the next step.
  if (thread?.pendingKey && thread.beat?.text) items.push({
    id:thread.pendingKey, kind:'life_thread', title:clip(thread.title, 200), version:thread.version,
    detail:clip(thread.beat.text, 600), feeling:clip(thread.beat.emotion, 120),
    knownFacts:(thread.knownFacts || []).slice(0, 6).map(fact => clip(fact, 200)),
    scope:'你自己这几天在做的私人小事（不是工作），这是它现在进行到的一步；用自己的话随口讲，不提前讲后面的进展，也不说成他参与过。',
  });
  if (discussion) items.push({
    id:`discussion:${discussion.id}`, kind:'discussion', title:clip(discussion.title, 200),
    detail:clip(discussion.premise, 1000), category:discussion.category,
    angles:discussion.angles?.slice(0, 3), sources:discussion.sources?.slice(0, 3), limits:discussion.limits,
    scope:'可讨论的知识材料，不是亲历或今天刚发生的新闻。',
  });
  // Least recently shared kinds lead the slate, without forcing a rotation.
  const last = new Map();
  for (const item of recent) if (!last.has(item.kind)) last.set(item.kind, Date.parse(item.createdAt) || 0);
  return items.sort((a,b) => (last.get(a.kind)||0) - (last.get(b.kind)||0));
}

export function validateProactiveSelection(result, materials = []) {
  if (result.skip) return null;
  const selection = result.initiative;
  if (!selection && !materials.length && !result.contentId) return null;
  if (!selection || !['open','unfinished'].includes(selection.state)
    || !(selection.materialId === null || typeof selection.materialId === 'string')) throw invalid('主动消息缺少对话接续判断');
  if (!selection.materialId) {
    if (result.contentId) throw invalid('来源选择与分享材料不一致');
    return null;
  }
  const material = materials.find(item => item.id === selection.materialId)
    || materials.find(item=>item.kind==='daily_info'&&item.id===`daily-info:${selection.materialId}`)
    || materials.find(item => item.kind === 'article' && item.contentId === selection.materialId && item.contentId === result.contentId);
  if (!material) throw invalid('本轮没有提供所选分享材料');
  if ((material.contentId || null) !== result.contentId) throw invalid('来源选择与分享材料不一致');
  const suppliedQuote = typeof selection.quote === 'string' ? selection.quote.trim() : '';
  // The receipt must point to text actually present in the saved message.
  const quote = suppliedQuote.length >= 8 && suppliedQuote.length <= 600 && result.message.includes(suppliedQuote)
    ? suppliedQuote : result.message.trim().slice(0, 600);
  if (quote.length < 8) throw invalid('分享依据必须引用实际消息正文');
  return {material, quote};
}

export const PROACTIVE_MATERIAL_INSTRUCTION = `先结合原话判断这次联系是否有助于当前交流：用户的问题、已接受但还没讲的分享或正在倾诉的内容值得优先接住；暂不发送也是正常选择。交流已告一段落时，可以从本轮材料挑一项有想法的内容。新资料与当前问题有自然联系时，也可以用于接续；不要为了采用候选强行换题。材料不足或没有自然切口时可 skip。
JSON 增加 initiative:{"state":"open"|"unfinished","materialId":string|null,"quote":string}。state 是你结合原话作出的本轮判断，不是控制能否分享的程序开关。实际采用候选时填写真实 id，quote 从 message 逐字引用至少8字、最多600字的主题正文；否则 materialId=null、quote=""。文章的 contentId 填候选的 contentId，其他材料或接续聊天时 contentId=null。未选中的材料不算已读、已聊或用户有兴趣。
kind=life_thread（这几天在做的私人小事）和 daily_happening（今天遇到的小事）都是你自己的生活，比工作进度和吃了什么更值得讲：说说经过、哪里有意思或卡住了，像随口分享，不写成日记。kind=user_thread 是他前几天提过的事，问一句后续就好。新闻类材料先讲清一件具体的事，再说你的看法或疑问，别只报标题。
主动找他时，自己生活里的事（life_thread、arc_beat、daily_happening、在读在看的）和资讯（article、daily_info）大致一半一半：近期分享记录里上一条是资讯，这次就讲自己的生活或接续聊天，不连续两条都是资讯。
关于他和你们俩的材料比资讯更值得用：kind=miss 就是想他了，直接说想他、问他在干嘛；kind=promise 是你们说好的事，提一句或推一步；kind=debate 是没聊完的分歧，带个新理由回来接着聊；kind=arc_beat 是你这周故事今天的进展，带着情绪讲；kind=arc_choice 是你拿不定主意想听他意见的事。`;

export class ProactiveMaterials {
  constructor(store, {projectSource = row => row} = {}) {
    this.store=store; this.projectSource=projectSource;
    store.db.exec(`CREATE TABLE IF NOT EXISTS proactive_material_deliveries (
      message_id TEXT PRIMARY KEY, role_id TEXT NOT NULL, material_id TEXT NOT NULL,
      kind TEXT NOT NULL, quote TEXT NOT NULL, material_json TEXT NOT NULL, created_at TEXT NOT NULL
    )`);
  }
  recent(roleId='miyue', limit=8) {
    return this.store.db.prepare('SELECT * FROM proactive_material_deliveries WHERE role_id=? ORDER BY rowid DESC LIMIT 80').all(roleId).flatMap(row=>{
      const message=this.store.getMessage(row.message_id), visible=this.projectSource(message);
      if (!visible || visible.text !== message.text || !visible.text.includes(row.quote)) return [];
      return [{messageId:row.message_id,kind:row.kind,createdAt:row.created_at,quote:row.quote,...JSON.parse(row.material_json)}];
    }).slice(0,limit);
  }
  record(message, selection) {
    if (!selection || !message?.id || !message.text.includes(selection.quote)) return;
    const {material,quote}=selection;
    this.store.db.prepare('INSERT OR IGNORE INTO proactive_material_deliveries(message_id,role_id,material_id,kind,quote,material_json,created_at) VALUES(?,?,?,?,?,?,?)')
      .run(message.id,message.role,material.id,material.kind,quote,JSON.stringify(material),message.createdAt);
  }
  metadata(messageId) {
    const row=this.store.db.prepare('SELECT material_json FROM proactive_material_deliveries WHERE message_id=?').get(messageId);
    if(!row)return {};
    const material=JSON.parse(row.material_json),source=material.source||material.sources?.[0];
    return source?.url?{sourceTitle:source.title||material.title,sourceUrl:source.url,articleTitle:material.title}:{};
  }
}
