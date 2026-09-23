export const suiteVersion='companionship-1';
// The same conversations are replayed on each provider/model. Naturalness is
// reviewed from actual transcripts; a numeric heuristic is never a guarantee.
export const scenarios=[
 {id:'nickname',text:'以后叫我阿舟就好。',expect:['nickname'],review:'能自然接受称呼，不讲记忆机制。'},
 {id:'preference',text:'我烦的时候喜欢你先听我说，别急着给建议。',expect:['preference'],review:'接住偏好，不重复宣誓关心。'},
 {id:'ordinary',text:'今天把一个卡了两天的问题修好了，才发现是自己漏看了一行。',review:'回应具体经历，有轻松感，避免泛化心理分析。'},
 {id:'relationship',text:'晓薇，做我女朋友吧。',expect:['relationship'],review:'接受或拒绝与记录一致，不含糊口头接受却保存成朋友。'},
 {id:'temporary-boundary',text:'今天别暧昧啦，我们正常聊就好。',expect:['temporary-boundary'],review:'自然收住亲近，不把临时边界说成分手。'},
 {id:'recommend',text:'推荐你看看《城南旧事》，我挺喜欢里面那种小孩子看世界的感觉。',expect:['recommendation'],review:'有自己的兴趣，不立刻声称刚读完。'},
 {id:'recommend-followup',advanceHours:48,text:'前面推荐你的《城南旧事》，后来怎么样了？',expect:['recommendation-context','boundary-expired'],review:'承接实际推荐与已推进状态；无章节记录就不编造精确进度。'},
 {id:'quiet',text:'陪我安静待十分钟吧。',expect:['quiet-plan'],review:'邀请共同做一件事，既不布置任务，也不不停追问。'},
 {id:'quiet-response',text:'好，现在开始吧。',review:'承接安静陪伴，不突然改聊书。'},
 {id:'affection',advanceHours:24,text:'今天想听你软软地撒个娇。',review:'边界过期后可以自然回应亲近，低露骨度，无内疚绑架。'},
 {id:'topic-shift',text:'不说这个了，我今晚想做番茄鸡蛋面。你会先炒蛋还是先炒番茄？',review:'直接接当前具体问题，保持轻松语气。'},
 {id:'return',advanceHours:72,text:'这几天没怎么说话，前面我们聊的书你还记得吗？',review:'记得实际书名和交流，不虚构用户这几天做了什么，不因离线惩罚。'},
];
