import { createHash } from 'node:crypto';
import { selectTurnMemory } from './turn-memory.mjs';

const hash = text => createHash('sha256').update(text).digest('hex');
const vector = value => Array.isArray(value) && value.length > 0 && value.length <= 8192 && value.every(Number.isFinite) ? value : null;
function cosine(a, b) {
  if (a.length !== b.length) return -1;
  let dot=0, aa=0, bb=0;
  for (let i=0;i<a.length;i++) { dot+=a[i]*b[i]; aa+=a[i]*a[i]; bb+=b[i]*b[i]; }
  return aa && bb ? dot / Math.sqrt(aa*bb) : -1;
}

// Every search starts from the current visible projection. Cached vectors can
// rank it, but can never resurrect a deleted, corrected or suppressed source.
export class HybridRecall {
  constructor(store, { model, embed, embeddingModel = '', semantic = false, getCandidates } = {}) {
    this.store=store; this.model=model; this.embed=embed; this.embeddingModel=embeddingModel; this.semantic=semantic; this.getCandidates=getCandidates;
    store.db.exec('CREATE TABLE IF NOT EXISTS recall_vectors(role_id TEXT NOT NULL,item_id TEXT NOT NULL,text_hash TEXT NOT NULL,model TEXT NOT NULL,vector_json TEXT NOT NULL,PRIMARY KEY(role_id,item_id,model))');
  }
  async index(roleId, candidates, { signal, limit=64, onCall } = {}) {
    if (!this.embed || !this.embeddingModel) return { status:'unconfigured', indexed:0, total:candidates.length };
    signal?.throwIfAborted();
    const cached=this.store.db.prepare('SELECT item_id,text_hash FROM recall_vectors WHERE role_id=? AND model=?').all(roleId,this.embeddingModel);
    const visible=new Map(candidates.map(c=>[c.id,hash(c.text)]));
    const known=new Map(cached.map(c=>[c.item_id,c.text_hash]));
    this.store.transaction(()=>{for(const c of cached)if(visible.get(c.item_id)!==c.text_hash)this.store.db.prepare('DELETE FROM recall_vectors WHERE role_id=? AND item_id=? AND model=?').run(roleId,c.item_id,this.embeddingModel);});
    const pending=candidates.filter(c=>known.get(c.id)!==visible.get(c.id)).slice(0,Math.max(1,Math.min(512,limit)));
    for(let offset=0;offset<pending.length;offset+=16){
      const batch=pending.slice(offset,offset+16);
      const result=await this.embed(batch.map(c=>c.text.slice(0,6000)),{signal,onCall,roleId});
      signal?.throwIfAborted();
      if(!Array.isArray(result)||result.length!==batch.length||result.some(v=>!vector(v)))throw new Error('INVALID_EMBEDDING_RESPONSE');
      const current=new Map((this.getCandidates?.(roleId)||candidates).map(c=>[c.id,hash(c.text)]));
      this.store.transaction(()=>batch.forEach((c,i)=>{if(current.get(c.id)===hash(c.text))this.store.db.prepare('INSERT OR REPLACE INTO recall_vectors VALUES(?,?,?,?,?)').run(roleId,c.id,hash(c.text),this.embeddingModel,JSON.stringify(result[i]));}));
    }
    const fresh=this.getCandidates?.(roleId)||candidates, hashes=new Map(fresh.map(c=>[c.id,hash(c.text)]));
    const indexed=this.store.db.prepare('SELECT item_id,text_hash FROM recall_vectors WHERE role_id=? AND model=?').all(roleId,this.embeddingModel).filter(c=>hashes.get(c.item_id)===c.text_hash).length;
    return {status:pending.length?'updated':'ready',indexed,total:fresh.length};
  }
  async search({roleId,candidates,query,semanticQuery='',now,budgetChars=3600,maxItems=6,signal,model=this.model,onCall}) {
    signal?.throwIfAborted();
    let expanded=semanticQuery, status='lexical', semanticIds=[], scores=[];
    if(this.embed&&this.embeddingModel){
      try{
        await this.index(roleId,candidates,{signal,onCall});
        const [q]=await this.embed([query],{signal,onCall,roleId});
        if(!vector(q))throw new Error('INVALID_EMBEDDING_RESPONSE');
        const visible=new Map(candidates.map(c=>[c.id,c]));
        scores=this.store.db.prepare('SELECT * FROM recall_vectors WHERE role_id=? AND model=?').all(roleId,this.embeddingModel).flatMap(row=>{
          const item=visible.get(row.item_id); if(!item||hash(item.text)!==row.text_hash)return [];
          const v=vector(JSON.parse(row.vector_json)); return v?[{id:item.id,score:cosine(q,v)}]:[];
        }).filter(c=>c.score>=0.55).sort((a,b)=>b.score-a.score).slice(0,8);
        semanticIds=scores.map(c=>c.id);status='hybrid-vector';
      }catch(error){if(signal?.aborted)throw signal.reason;status='embedding-unavailable';}
    } else if(this.semantic&&model){
      try{
        // Query expansion produces search terms, never remembered facts. Each
        // returned item still has to exist in the full visible evidence set.
        const bounded=signal?AbortSignal.any([signal,AbortSignal.timeout(8000)]):AbortSignal.timeout(8000);
        const raw=await model.complete([{role:'system',content:'把用户的历史检索问题改写为最多三个语义相近的简短检索词组。可以展开常见同义表达，不能回答问题或编造具体的人名、日期、经历。只输出 JSON {"queries":[string]}。'},{role:'user',content:query}],{purpose:'recall-query',roleId,signal:bounded,jsonObject:true,nonThinking:true,maxTokens:500});
        const parsed=JSON.parse(raw);if(!Array.isArray(parsed.queries)||parsed.queries.length>3||parsed.queries.some(q=>typeof q!=='string'||q.length>160))throw new Error('INVALID_QUERY_EXPANSION');
        expanded+=" "+parsed.queries.filter(x=>typeof x==='string'&&x.length<=160).join(' ');
        status='hybrid-query';
      }catch(error){if(signal?.aborted)throw signal.reason;status='query-unavailable';}
    }
    signal?.throwIfAborted();
    const currentCandidates=this.getCandidates?.(roleId)||candidates;
    const currentHashes=new Map(currentCandidates.map(c=>[c.id,hash(c.text)]));
    const originalHashes=new Map(candidates.map(c=>[c.id,hash(c.text)]));
    semanticIds=semanticIds.filter(id=>currentHashes.get(id)===originalHashes.get(id));
    const result=selectTurnMemory({query,semanticQuery:expanded,semanticIds,candidates:currentCandidates,now,budgetChars,maxItems});
    return {...result,retrieval:{status,candidateCount:candidates.length,vectorCoverage:this.embed?this.store.db.prepare('SELECT COUNT(*) n FROM recall_vectors WHERE role_id=? AND model=?').get(roleId,this.embeddingModel).n:0,scores}};
  }
}
