import { randomUUID } from 'node:crypto';

const invalid = message => Object.assign(new Error(message), { code: 'INVALID_SESSION_ACTION', status: 400 });

// Validate now, commit with the final reply. Cancelled/failed generations have
// no side effects, and a failed commit cannot deliver a false confirmation.
export function sessionReminderActions({ store, roleId, userText, replyChannel = 'desktop', clock = () => new Date() }) {
  const plans = new Map();
  const initial = new Map(store.listReminders().filter(row => row.role === roleId).map(row => [row.id, row]));
  const originChannel = replyChannel === 'weixin' ? 'weixin' : 'desktop';
  return {
    prepare(request) {
      const { action, evidence } = request;
      if (!['create', 'update', 'cancel'].includes(action)) throw invalid('不支持的提醒操作');
      if (!userText || typeof evidence !== 'string' || !evidence.trim() || !userText.includes(evidence)) throw invalid('需要当前用户原话作为操作依据');
      if (plans.size >= 3) throw invalid('本轮提醒操作已达到上限');
      const id = action === 'create' ? randomUUID() : request.id;
      const previous = initial.get(id);
      if (action !== 'create' && (!previous || previous.status !== 'pending')) throw invalid('这项提醒不存在或已处理，请先读取当前状态');
      if (plans.has(id)) throw invalid('同一提醒本轮已修改，请根据已准备的结果完成回复');
      const text = action === 'cancel' ? previous.text : request.text ?? previous?.text;
      if (typeof text !== 'string' || !text.trim() || text.length > 4000) throw invalid('提醒内容无效');
      const dueAt = action === 'cancel' ? previous.dueAt : request.dueAt ?? previous?.dueAt;
      if (typeof dueAt !== 'string' || !/(?:Z|[+-]\d{2}:\d{2})$/.test(dueAt) || !Number.isFinite(Date.parse(dueAt))) throw invalid('提醒时间须为带时区的完整日期');
      const delta = Date.parse(dueAt) - +new Date(clock());
      if (action !== 'cancel' && (delta <= 0 || delta > 366 * 86400000)) throw invalid('提醒须安排在未来一年内');
      const duplicate = action === 'create' && [...initial.values(), ...plans.values()].find(row => row.action !== 'cancel' && row.text === text.trim() && row.dueAt === new Date(dueAt).toISOString() && (row.status === 'pending' || row.action));
      if (duplicate) return { status: 'already_scheduled', id: duplicate.id, text: duplicate.text, dueAt: duplicate.dueAt };
      const plan = { id, role: roleId, action, text: text.trim(), dueAt: new Date(dueAt).toISOString(), previous };
      plans.set(id, plan);
      return { status: 'validated_for_reply_commit', id, action, text: plan.text, dueAt: plan.dueAt, note: '此操作随最终回复原子提交；提交失败时回复不会发出。' };
    },
    get size() { return plans.size; },
    commit() {
      for (const plan of plans.values()) {
        if (plan.action === 'create') {
          store.db.prepare("INSERT INTO reminders(id,role,text,due_at,status,created_at,delivery_kind,origin_channel) VALUES(?,?,?,?,?,?,'commitment',?)")
            .run(plan.id, roleId, plan.text, plan.dueAt, 'pending', store.now(), originChannel);
        } else {
          const previous = plan.previous;
          const result = plan.action === 'cancel'
            ? store.db.prepare("DELETE FROM reminders WHERE id=? AND role=? AND status='pending' AND text=? AND due_at=?").run(plan.id, roleId, previous.text, previous.dueAt)
            : store.db.prepare("UPDATE reminders SET text=?,due_at=? WHERE id=? AND role=? AND status='pending' AND text=? AND due_at=?").run(plan.text, plan.dueAt, plan.id, roleId, previous.text, previous.dueAt);
          if (result.changes !== 1) throw Object.assign(new Error('提醒已变化，请重新准备'), { code: 'STALE_SESSION_ACTION', status: 409 });
        }
      }
    },
  };
}
