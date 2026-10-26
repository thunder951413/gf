// "她是谁" — the parts of her persona he decides (COMPANION-ALIVENESS.md 10,
// P5-4). Stored as one setting and laid over app-data/roles.json at runtime,
// so both identities and every prompt read the same person.
const KEY = 'persona_overrides';
export const PERSONA_FIELDS = Object.freeze({
  appearance: { label: '形象', max: 300, hint: '她看起来什么样：身高身形、发型、常穿的风格、给人的感觉（AI 身份下就是桌面上那个她的样子）' },
  temperament: { label: '性格', max: 300, hint: '她的性格底色和小脾气' },
  background: { label: '背景', max: 500, hint: '她是做什么的、住在哪、家里和朋友（只在真人身份用；留空就用默认的苏州设计师）' },
  speech: { label: '说话方式', max: 200, hint: '口头禅、语气、爱用的词' },
  likes: { label: '喜欢', max: 12, list: true, hint: '一行一个' },
  dislikes: { label: '不喜欢', max: 12, list: true, hint: '一行一个' },
  opinions: { label: '她的看法', max: 20, list: true, hint: '一行一条她对事情的态度，聊到相关话题时会拿出来' },
});
const clip = (value, max) => String(value ?? '').replace(/\r/gu, '').trim().slice(0, max);

export function readPersona(db) {
  try { const value = JSON.parse(db.prepare('SELECT value FROM metadata WHERE key=?').get(KEY)?.value || 'null'); return value && typeof value === 'object' ? value : {}; }
  catch { return {}; }
}

export function validatePersona(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw Object.assign(new Error('格式无效'), { status: 400, code: 'INVALID_PERSONA' });
  const result = {};
  for (const [key, field] of Object.entries(PERSONA_FIELDS)) {
    if (input[key] === undefined || input[key] === null) continue;
    if (field.list) {
      const items = (Array.isArray(input[key]) ? input[key] : String(input[key]).split('\n')).map(item => clip(item, 80)).filter(Boolean).slice(0, field.max);
      if (items.length) result[key] = items;
    } else { const text = clip(input[key], field.max); if (text) result[key] = text; }
  }
  return result;
}

export function savePersona(db, input, { now = new Date() } = {}) {
  const value = validatePersona(input);
  db.prepare('INSERT INTO metadata(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(KEY, JSON.stringify({ ...value, savedAt: new Date(now).toISOString() }));
  return value;
}

// The profile prompts read: defaults from roles.json with his choices on top.
// A custom background replaces the default life story; the default cast and
// city only apply when he has not written his own.
export function applyPersona(baseProfile = {}, overrides = {}) {
  const profile = structuredClone(baseProfile);
  for (const key of ['appearance', 'temperament', 'speech', 'likes', 'dislikes', 'opinions']) if (overrides[key]) profile[key] = overrides[key];
  if (overrides.background) {
    profile.customBackground = overrides.background;
    for (const key of ['occupation', 'home', 'background', 'socialCircle', 'socialGroups', 'age']) delete profile[key];
  }
  return profile;
}
