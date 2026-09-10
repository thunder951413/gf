const MAX_MOMENTS = 100;
const MAX_CAPTION_LENGTH = 500;

function error(message, status, code, ErrorType = Error) {
  const result = new ErrorType(message);
  result.status = status;
  result.code = code;
  return result;
}

function validateCaption(value) {
  if (typeof value !== 'string' || value.length > MAX_CAPTION_LENGTH) {
    throw error(`caption must be a string of at most ${MAX_CAPTION_LENGTH} characters`, 400, 'INVALID_MOMENT_CAPTION', TypeError);
  }
  return value;
}

function validateImage(value) {
  if (value !== null && typeof value !== 'string') {
    throw error('image must be a validated string or null', 400, 'INVALID_MOMENT_IMAGE', TypeError);
  }
  return value;
}

function validateMessage(message) {
  if (!message || typeof message.id !== 'string' || !message.id.trim()
    || typeof message.role !== 'string' || !message.role.trim()
    || typeof message.text !== 'string'
    || !['assistant', 'user'].includes(message.speaker)) {
    throw error('message must be an existing user or assistant message', 400, 'INVALID_MOMENT_MESSAGE', TypeError);
  }
  return message;
}

function mapMoment(row) {
  return {
    messageId: row.message_id,
    roleId: row.role_id,
    text: row.text,
    image: row.image,
    caption: row.caption,
    createdAt: row.created_at,
  };
}

export class MomentsRepository {
  constructor(store) {
    if (!store?.db || typeof store.transaction !== 'function') {
      throw new TypeError('store with db and transaction is required');
    }
    this.store = store;
    store.db.exec(`
      CREATE TABLE IF NOT EXISTS saved_moments (
        message_id TEXT PRIMARY KEY,
        role_id TEXT NOT NULL,
        text TEXT NOT NULL,
        image TEXT,
        caption TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS saved_moments_role_time
        ON saved_moments(role_id, created_at);
    `);
  }

  #get(messageId) {
    const row = this.store.db.prepare('SELECT * FROM saved_moments WHERE message_id=?').get(String(messageId));
    return row ? mapMoment(row) : null;
  }

  save(message, options = {}) {
    const source = validateMessage(message);
    const hasImage = options.image !== undefined;
    const hasCaption = options.caption !== undefined;
    const suppliedImage = hasImage ? validateImage(options.image) : undefined;
    const suppliedCaption = hasCaption ? validateCaption(options.caption) : undefined;

    return this.store.transaction(() => {
      const existing = this.#get(source.id);
      if (!existing) {
        const count = Number(this.store.db.prepare('SELECT COUNT(*) AS n FROM saved_moments').get().n);
        if (count >= MAX_MOMENTS) {
          throw error(`at most ${MAX_MOMENTS} moments can be saved`, 409, 'MOMENT_LIMIT_REACHED', RangeError);
        }
        const createdAt = new Date().toISOString();
        this.store.db.prepare(`
          INSERT INTO saved_moments(message_id,role_id,text,image,caption,created_at)
          VALUES(?,?,?,?,?,?)
        `).run(source.id, source.role, source.text, hasImage ? suppliedImage : null, hasCaption ? suppliedCaption : '', createdAt);
      } else {
        this.store.db.prepare(`
          UPDATE saved_moments SET role_id=?,text=?,image=?,caption=? WHERE message_id=?
        `).run(
          source.role,
          source.text,
          hasImage ? suppliedImage : existing.image,
          hasCaption ? suppliedCaption : existing.caption,
          source.id,
        );
      }
      return this.#get(source.id);
    });
  }

  list({ roleId } = {}) {
    const rows = roleId === undefined
      ? this.store.db.prepare('SELECT * FROM saved_moments ORDER BY created_at DESC, rowid DESC').all()
      : this.store.db.prepare('SELECT * FROM saved_moments WHERE role_id=? ORDER BY created_at DESC, rowid DESC').all(String(roleId));
    return rows.map(mapMoment);
  }

  update(messageId, patch = {}) {
    const hasImage = patch.image !== undefined;
    const hasCaption = patch.caption !== undefined;
    const suppliedImage = hasImage ? validateImage(patch.image) : undefined;
    const suppliedCaption = hasCaption ? validateCaption(patch.caption) : undefined;

    return this.store.transaction(() => {
      const existing = this.#get(messageId);
      if (!existing) return null;
      if (hasImage || hasCaption) {
        this.store.db.prepare('UPDATE saved_moments SET image=?,caption=? WHERE message_id=?').run(
          hasImage ? suppliedImage : existing.image,
          hasCaption ? suppliedCaption : existing.caption,
          existing.messageId,
        );
      }
      return this.#get(existing.messageId);
    });
  }

  remove(messageId) {
    return this.store.db.prepare('DELETE FROM saved_moments WHERE message_id=?').run(String(messageId)).changes > 0;
  }
}

export const momentLimits = Object.freeze({ maxItems: MAX_MOMENTS, maxCaptionLength: MAX_CAPTION_LENGTH });
