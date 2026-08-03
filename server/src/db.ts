import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

const migrations = [
  `
  CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
  CREATE TABLE categories (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL COLLATE NOCASE UNIQUE,
    placement TEXT NOT NULL CHECK(placement IN ('main','additional')),
    sort_order INTEGER NOT NULL DEFAULT 0,
    color TEXT,
    version INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    archived_at TEXT
  );
  CREATE INDEX categories_order_idx ON categories(placement, sort_order);
  CREATE TABLE expenses (
    id TEXT PRIMARY KEY,
    amount_minor INTEGER NOT NULL CHECK(amount_minor > 0),
    currency TEXT NOT NULL CHECK(length(currency) = 3),
    category_id TEXT NOT NULL REFERENCES categories(id),
    occurred_at TEXT NOT NULL,
    note TEXT CHECK(note IS NULL OR length(note) <= 500),
    version INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT
  );
  CREATE INDEX expenses_occurred_idx ON expenses(occurred_at DESC) WHERE deleted_at IS NULL;
  CREATE TABLE sessions (
    token_hash TEXT PRIMARY KEY,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX sessions_expiry_idx ON sessions(expires_at);
  CREATE TABLE sync_operations (
    operation_id TEXT PRIMARY KEY,
    result_json TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE exchange_rates (
    rate_date TEXT NOT NULL,
    base_currency TEXT NOT NULL,
    quote_currency TEXT NOT NULL,
    rate REAL NOT NULL CHECK(rate > 0),
    fetched_at TEXT NOT NULL,
    PRIMARY KEY(rate_date, base_currency, quote_currency)
  );
  CREATE INDEX exchange_rates_lookup_idx ON exchange_rates(base_currency, quote_currency, rate_date DESC);
  `,
  `
  ALTER TABLE sessions ADD COLUMN pin_fingerprint TEXT;
  CREATE TABLE app_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  `
];

const seeds = [
  ["products", "Продукты", "main", 0, "#7CB98B"],
  ["eating-out", "Eating out", "main", 1, "#E9A76F"],
  ["home", "Для дома", "additional", 0, "#79A9D1"],
  ["waffle", "Вафля", "additional", 1, "#D7A0BF"],
  ["entertainment", "Развлечения", "additional", 2, "#A493D1"],
  ["subscriptions", "Подписки", "additional", 3, "#8DB8B0"],
  ["other", "Прочее", "additional", 4, "#A8A8A8"]
] as const;

export function openDatabase(path: string): Database.Database {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  const migrate = db.transaction(() => {
    db.exec("CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)");
    for (let i = 0; i < migrations.length; i++) {
      const version = i + 1;
      if (!db.prepare("SELECT 1 FROM schema_migrations WHERE version = ?").get(version)) {
        db.exec(migrations[i]!);
        db.prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)").run(version, new Date().toISOString());
      }
    }
    const insert = db.prepare(`INSERT OR IGNORE INTO categories
      (id,name,placement,sort_order,color,version,created_at,updated_at) VALUES (?,?,?,?,?,1,?,?)`);
    const now = new Date().toISOString();
    for (const seed of seeds) insert.run(...seed, now, now);
  });
  migrate();
  return db;
}

export function startBackupHeartbeat(db: Database.Database): () => void {
  const write = () => db.prepare(`INSERT INTO app_meta(key,value) VALUES ('backup_heartbeat',?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(new Date().toISOString());
  write();
  const timer = setInterval(write, 6 * 60 * 60 * 1000);
  timer.unref();
  return () => clearInterval(timer);
}
