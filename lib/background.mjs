export const DEFAULT_BACKGROUND = Object.freeze({
  image: null,
  mode: 'cover',
  position: 'center',
  veil: 0.35,
  blur: 0,
});

export class BackgroundRepository {
  constructor(store) {
    this.store = store;
    this.db = store.db;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS background_settings (
        id INTEGER PRIMARY KEY CHECK(id=1),
        image TEXT,
        mode TEXT NOT NULL CHECK(mode IN ('cover', 'contain', 'stretch', 'tile')),
        position TEXT NOT NULL CHECK(position IN ('center', 'top', 'bottom')),
        veil REAL NOT NULL CHECK(veil >= 0 AND veil <= 0.9),
        blur REAL NOT NULL CHECK(blur >= 0 AND blur <= 12)
      );
    `);
    this.db.prepare('INSERT OR IGNORE INTO background_settings(id,image,mode,position,veil,blur) VALUES(1,?,?,?,?,?)')
      .run(DEFAULT_BACKGROUND.image, DEFAULT_BACKGROUND.mode, DEFAULT_BACKGROUND.position, DEFAULT_BACKGROUND.veil, DEFAULT_BACKGROUND.blur);
  }

  get() {
    const row = this.db.prepare('SELECT image, mode, position, veil, blur FROM background_settings WHERE id=1').get();
    return { image: row.image, mode: row.mode, position: row.position, veil: row.veil, blur: row.blur };
  }

  set(background) {
    this.db.prepare('UPDATE background_settings SET image=?, mode=?, position=?, veil=?, blur=? WHERE id=1')
      .run(background.image, background.mode, background.position, background.veil, background.blur);
    return this.get();
  }
}
