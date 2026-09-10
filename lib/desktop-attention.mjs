const invalid = (message, status = 400, code = 'INVALID_DESKTOP_ATTENTION') => Object.assign(new Error(message), { status, code });

export function desktopAttentionEvent(level) {
  const affection = level === 'affection';
  return {
    text: affection ? '【桌面互动：再次双击，想要亲亲抱抱和关心】' : '【桌面互动：双击，想被关心、被惦记】',
    // Route the gesture through the existing explicit-closeness policy without
    // storing this interpretation as something the user literally said.
    intentText: affection ? '亲亲我，抱抱我，哄哄我' : '哄哄我，想被你关心、被你惦记',
    context: `【用户主动发起的桌面互动】\n这轮是用户${affection ? '再次双击桌面人物，在刚才的亲近基础上还想被亲亲、抱抱、安慰和关心' : '双击桌面人物，想得到你的关心、想念和陪伴'}。这是明确的非语言亲近邀请，不是用户说出的原话，不是在问怎么操作软件，也不能据此推断他发生了坏事。\n${affection ? '自然接着刚才的话更亲昵一点，可以用聊天里的亲亲、抱抱和直接的关爱回应，让他感到被珍惜。无需再次问他要不要聊天，也不转去介绍资讯。' : '由你先开口，自然表达惦记、关心或想陪他说说话。可以轻轻问怎么啦或是不是想你了，也可以直接说一句温暖的话。先给陪伴，不把选话题的任务推回他；可以提出找一点有趣的内容，但没有实际检索就不说已经搜到、读完或看到了什么。'}\n看最近对话，自然变化措辞，不每次复述同一套开场，不机械照抄示例。不要分析用户为何需要情绪价值，不讲操作说明，不要求承诺或索要回报。不必编造阅读、工作等生活事件作为开头。保持你们已有的相处语气，通常一到三句即可。`,
  };
}

/** Receipts are saved in the same transaction as the chat turn: retrying a
 * timed-out native request (including after a restart) cannot send it twice. */
export class DesktopAttention {
  constructor(store, { execute, isBusy, getRevision, isClosing = () => false }) {
    Object.assign(this, { store, execute, isBusy, getRevision, isClosing });
    this.inFlight = new Map();
    store.db.exec('CREATE TABLE IF NOT EXISTS desktop_attention_receipts (request_id TEXT PRIMARY KEY, level TEXT NOT NULL, message_ids TEXT NOT NULL)');
  }
  interrupt() {
    for (const pending of this.inFlight.values()) pending.controller.abort();
  }
  request(body) {
    const { requestId, level } = body || {};
    if (typeof requestId !== 'string' || !/^[a-zA-Z0-9_-]{8,100}$/.test(requestId) || !['care', 'affection'].includes(level)) throw invalid('桌面互动参数无效');
    const receipt = this.store.db.prepare('SELECT * FROM desktop_attention_receipts WHERE request_id=?').get(requestId);
    const pending = this.inFlight.get(requestId);
    if ((receipt && receipt.level !== level) || (pending && pending.level !== level)) throw invalid('这次互动标识已经使用', 409, 'DESKTOP_ATTENTION_CONFLICT');
    if (receipt) {
      const messages = JSON.parse(receipt.message_ids).map(id => this.store.getMessage(id));
      if (messages.some(message => !message)) throw invalid('这次互动的聊天记录已删除', 410, 'DESKTOP_ATTENTION_REMOVED');
      return Promise.resolve({ messages });
    }
    if (pending) return pending.promise;
    if (this.isClosing()) throw invalid('服务正在重启，请稍后再试', 503);
    if (this.isBusy()) throw invalid('她正在回复，稍等这句话说完', 409, 'ROLE_BUSY');
    const revision = this.getRevision();
    const controller = new AbortController();
    const isCurrent = () => !controller.signal.aborted && !this.isClosing() && this.getRevision() === revision;
    const event = desktopAttentionEvent(level);
    const promise = this.execute({ role: 'miyue', text: event.text }, {
      desktopAttention: event,
      signal: controller.signal,
      isCurrent,
      afterSave: rows => {
        if (!isCurrent()) throw invalid('对话已更新，稍后再接着说', 409, 'ROLE_BUSY');
        this.store.db.prepare('INSERT INTO desktop_attention_receipts VALUES(?,?,?)').run(requestId, level, JSON.stringify(rows.map(row => row.id)));
      },
    }).finally(() => this.inFlight.delete(requestId));
    this.inFlight.set(requestId, { level, promise, controller });
    return promise;
  }
}
