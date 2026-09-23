// A semantic decision chooses the conversation route, never a state mutation.
export const OPEN_SEMANTIC = Object.freeze({intent:'open',continuity:'uncertain',focusMessageId:null,ownLife:false,advice:false,emotionalDetail:false,imagined:false,correction:false,acceptsOffer:false,source:'none',retrievalQuery:'',evidence:''});

export function semanticIntent(decision) {
  const kind=decision.intent;
  const declined=kind==='boundary',affection=kind==='affection',weary=kind==='comfort',handoff=kind==='share',recall=kind==='recall';
  return {declined,affection,weary,handoff,recall,invitation:false,presence:weary,clarify:false,question:kind==='answer',
    kind:({affection:'affection_reply',open:'respond',preference:'respond',close:'close',acknowledge:'respond'})[kind]||kind,
    understanding:{kind:kind==='preference'?'conversation_preference':declined?'boundary':decision.imagined?'imagined_closeness':decision.correction?'correction':decision.advice?'help':'open',romanticImagination:decision.imagined,correction:decision.correction,adviceRequested:decision.advice,emotionalDetail:decision.emotionalDetail,reality:decision.imagined?'imagined':'unspecified'},
  };
}
