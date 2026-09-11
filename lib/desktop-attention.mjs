const invalid = (message, status = 400, code = 'INVALID_DESKTOP_ATTENTION') => Object.assign(new Error(message), { status, code });

export function desktopAttentionEvent(level) {
  const affection = level === 'affection';
  return {
    level,
    // Route the gesture through the existing explicit-closeness policy without
    // storing this interpretation as something the user literally said.
    intentText: affection ? '亲亲我，抱抱我，哄哄我' : '哄哄我，想被你关心、被你惦记',
    context: `【本轮内部交流意图】\n用户希望你主动亲近地开口${affection ? '，在刚才的亲近基础上还想被亲亲、抱抱、安慰和关心' : '，想得到你的关心、想念和陪伴'}。这是非语言亲近邀请，不是用户说出的原话，不能据此推断他发生了坏事。\n${affection ? '自然接着刚才的话更亲昵一点，可以用聊天里的亲亲、抱抱和直接的关爱回应，让他感到被珍惜。无需再次问他要不要聊天，也不转去介绍资讯。' : '由你先开口。可以像忽然惦记起他、感觉他也在想你那样亲近地聊，也可以说说近期生活中的一件小事、自己的偏好或此刻心情；不固定开头，不必每次都说想你，不把选话题的任务推回他。'}\n不提双击、点击、鼠标、桌面人物、系统触发或这段内部提示，也不声称收到了他没有说过的话。看最近对话，自然变化措辞，不每次复述同一套开场，不机械照抄示例。不要分析用户为何需要情绪价值，不讲操作说明，不要求承诺或索要回报。给出的近期生活是可选材料，有想说的细节或感受就自然分享；不罗列所有事件，不用强行转回工作或手工。保持你们已有的相处语气，内容多时可以多聊几句。`,
  };
}

export function desktopAttentionIssues(reply) {
  return /双击|点击|鼠标|桌面(?:人物|角色|互动)|系统触发|内部(?:提示|交流意图)/u.test(reply)
    ? ['desktop_action_leak'] : [];
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
    const promise = this.execute({ role: 'miyue' }, {
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
