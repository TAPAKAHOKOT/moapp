import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
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
  ["eating-out", "Кафе и рестораны", "main", 1, "#E9A76F"],
  ["home", "Для дома", "additional", 0, "#79A9D1"],
  ["waffle", "Вафля", "additional", 1, "#D7A0BF"],
  ["entertainment", "Развлечения", "additional", 2, "#A493D1"],
  ["subscriptions", "Подписки", "additional", 3, "#8DB8B0"],
  ["other", "Прочее", "additional", 4, "#A8A8A8"]
] as const;

const LATEST_SCHEMA_VERSION = 8;

type TableCount = {
  categories: number;
  expenses: number;
  syncOperations: number;
};

function tableExists(db: Database.Database, table: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table));
}

function schemaVersionAtStartup(db: Database.Database): number {
  if (!tableExists(db, "schema_migrations")) return 0;
  const row = db.prepare("SELECT max(version) AS version FROM schema_migrations").get() as { version: number | null };
  return row.version ?? 0;
}

function tableCount(db: Database.Database, table: "categories" | "expenses" | "sync_operations"): number {
  const row = db.prepare(`SELECT count(*) AS count FROM ${table}`).get() as { count: number };
  return row.count;
}

function assertIntegrity(db: Database.Database, expected: TableCount): void {
  const actual = {
    categories: tableCount(db, "categories"),
    expenses: tableCount(db, "expenses"),
    syncOperations: tableCount(db, "sync_operations")
  };
  if (actual.categories !== expected.categories || actual.expenses !== expected.expenses || actual.syncOperations !== expected.syncOperations) {
    throw new Error(`Migration v3 row-count mismatch: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }

  const missingOwners = db.prepare(`SELECT w.id
    FROM workspaces w
    LEFT JOIN memberships m ON m.workspace_id = w.id AND m.user_id = w.owner_user_id
    WHERE m.user_id IS NULL`).all();
  if (missingOwners.length > 0) throw new Error("Migration v3 produced a workspace without its owner membership");

  const foreignKeyErrors = db.pragma("foreign_key_check") as unknown[];
  if (foreignKeyErrors.length > 0) throw new Error(`Migration v3 foreign-key check failed: ${JSON.stringify(foreignKeyErrors)}`);

  const quickCheck = db.pragma("quick_check") as { quick_check: string }[];
  if (quickCheck.length !== 1 || quickCheck[0]?.quick_check !== "ok") {
    throw new Error(`Migration v3 quick check failed: ${JSON.stringify(quickCheck)}`);
  }
}

function migrateToVersion3(
  db: Database.Database,
  wasLegacyInstallation: boolean,
  legacyUserId: string,
  legacyWorkspaceId: string,
  appliedAt: string
): void {
  const expected = {
    categories: tableCount(db, "categories"),
    expenses: tableCount(db, "expenses"),
    syncOperations: tableCount(db, "sync_operations")
  };

  db.exec(`
    CREATE TABLE users (
      id TEXT PRIMARY KEY,
      display_name TEXT NOT NULL,
      recovery_token_hash TEXT UNIQUE,
      recovery_generation INTEGER NOT NULL DEFAULT 0 CHECK(recovery_generation >= 0),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE memberships (
      workspace_id TEXT NOT NULL REFERENCES workspaces(id),
      user_id TEXT NOT NULL REFERENCES users(id),
      joined_at TEXT NOT NULL,
      added_by_user_id TEXT REFERENCES users(id),
      PRIMARY KEY(workspace_id, user_id)
    );
    CREATE INDEX memberships_user_idx ON memberships(user_id, workspace_id);

    CREATE TABLE workspaces (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      owner_user_id TEXT NOT NULL REFERENCES users(id),
      version INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(id, owner_user_id),
      FOREIGN KEY(id, owner_user_id) REFERENCES memberships(workspace_id, user_id)
        DEFERRABLE INITIALLY DEFERRED
    );

    CREATE TABLE sessions_new (
      id TEXT PRIMARY KEY,
      token_hash TEXT UNIQUE NOT NULL,
      user_id TEXT NOT NULL REFERENCES users(id),
      kind TEXT NOT NULL CHECK(kind IN ('normal','legacy_claim_pending')),
      label TEXT NOT NULL,
      created_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      revoked_at TEXT
    );
    DROP TABLE sessions;
    ALTER TABLE sessions_new RENAME TO sessions;
    CREATE INDEX sessions_user_idx ON sessions(user_id, created_at);
    CREATE INDEX sessions_expiry_idx ON sessions(expires_at);
    CREATE INDEX sessions_active_idx ON sessions(user_id, last_seen_at) WHERE revoked_at IS NULL;

    CREATE TABLE access_tokens (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL CHECK(kind IN ('invitation','device_link','recovery_rotation')),
      token_hash TEXT UNIQUE NOT NULL,
      workspace_id TEXT REFERENCES workspaces(id),
      target_user_id TEXT REFERENCES users(id),
      created_by_user_id TEXT REFERENCES users(id),
      created_by_session_id TEXT REFERENCES sessions(id),
      replacement_token_hash TEXT,
      expected_generation INTEGER CHECK(expected_generation IS NULL OR expected_generation >= 0),
      revoke_sessions INTEGER NOT NULL DEFAULT 0 CHECK(revoke_sessions IN (0,1)),
      accept_attempt_hash TEXT,
      accepted_session_id TEXT REFERENCES sessions(id),
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      consumed_at TEXT,
      revoked_at TEXT,
      CHECK(
        (kind = 'invitation'
          AND workspace_id IS NOT NULL AND target_user_id IS NULL
          AND created_by_user_id IS NOT NULL AND created_by_session_id IS NOT NULL
          AND replacement_token_hash IS NULL AND expected_generation IS NULL
          AND revoke_sessions = 0
          AND accept_attempt_hash IS NULL AND accepted_session_id IS NULL)
        OR
        (kind = 'device_link'
          AND workspace_id IS NULL AND target_user_id IS NOT NULL
          AND created_by_user_id IS NOT NULL AND created_by_session_id IS NOT NULL
          AND created_by_user_id = target_user_id
          AND replacement_token_hash IS NULL AND expected_generation IS NULL
          AND revoke_sessions = 0
          AND ((consumed_at IS NULL AND accept_attempt_hash IS NULL AND accepted_session_id IS NULL)
            OR (consumed_at IS NOT NULL AND accept_attempt_hash IS NOT NULL AND accepted_session_id IS NOT NULL)))
        OR
        (kind = 'recovery_rotation'
          AND workspace_id IS NULL AND target_user_id IS NOT NULL
          AND replacement_token_hash IS NOT NULL AND expected_generation IS NOT NULL
          AND accept_attempt_hash IS NULL AND accepted_session_id IS NULL
          AND ((revoke_sessions = 0 AND created_by_user_id IS NOT NULL
              AND created_by_user_id = target_user_id AND created_by_session_id IS NOT NULL)
            OR (revoke_sessions = 1 AND created_by_user_id IS NULL AND created_by_session_id IS NULL)))
      )
    );
    CREATE INDEX access_tokens_kind_idx ON access_tokens(kind);
    CREATE INDEX access_tokens_target_idx ON access_tokens(target_user_id, kind);
    CREATE INDEX access_tokens_workspace_idx ON access_tokens(workspace_id, kind);
    CREATE INDEX access_tokens_expiry_idx ON access_tokens(expires_at);

    CREATE TABLE legacy_claims (
      workspace_id TEXT PRIMARY KEY,
      owner_user_id TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('open','claimed_pending','closed')),
      attempt_hash TEXT,
      pending_session_id TEXT REFERENCES sessions(id),
      pending_expires_at TEXT,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(workspace_id, owner_user_id) REFERENCES workspaces(id, owner_user_id),
      CHECK(
        (state = 'open' AND attempt_hash IS NULL AND pending_session_id IS NULL AND pending_expires_at IS NULL)
        OR (state = 'claimed_pending' AND attempt_hash IS NOT NULL AND pending_session_id IS NOT NULL AND pending_expires_at IS NOT NULL)
        OR (state = 'closed' AND attempt_hash IS NULL AND pending_session_id IS NULL AND pending_expires_at IS NULL)
      )
    );
    CREATE UNIQUE INDEX legacy_claims_singleton_idx ON legacy_claims((1));

    CREATE TABLE categories_new (
      workspace_id TEXT NOT NULL REFERENCES workspaces(id),
      id TEXT NOT NULL,
      name TEXT NOT NULL COLLATE NOCASE,
      placement TEXT NOT NULL CHECK(placement IN ('main','additional')),
      sort_order INTEGER NOT NULL DEFAULT 0,
      color TEXT,
      version INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      archived_at TEXT,
      PRIMARY KEY(workspace_id, id),
      UNIQUE(workspace_id, name COLLATE NOCASE)
    );
    CREATE TABLE expenses_new (
      workspace_id TEXT NOT NULL,
      id TEXT NOT NULL,
      amount_minor INTEGER NOT NULL CHECK(amount_minor > 0),
      currency TEXT NOT NULL CHECK(length(currency) = 3),
      category_id TEXT NOT NULL,
      occurred_at TEXT NOT NULL,
      note TEXT CHECK(note IS NULL OR length(note) <= 500),
      version INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT,
      PRIMARY KEY(workspace_id, id),
      FOREIGN KEY(workspace_id, category_id) REFERENCES categories_new(workspace_id, id)
    );
    CREATE TABLE sync_operations_new (
      workspace_id TEXT NOT NULL REFERENCES workspaces(id),
      operation_id TEXT NOT NULL,
      result_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY(workspace_id, operation_id)
    );
  `);

  if (wasLegacyInstallation) {
    db.prepare(`INSERT INTO users
      (id,display_name,recovery_token_hash,recovery_generation,created_at,updated_at)
      VALUES (?, ?, NULL, 0, ?, ?)`).run(legacyUserId, "Владелец", appliedAt, appliedAt);
    db.prepare(`INSERT INTO workspaces
      (id,name,owner_user_id,version,created_at,updated_at) VALUES (?, ?, ?, 1, ?, ?)`)
      .run(legacyWorkspaceId, "Основное", legacyUserId, appliedAt, appliedAt);
    db.prepare(`INSERT INTO memberships
      (workspace_id,user_id,joined_at,added_by_user_id) VALUES (?, ?, ?, NULL)`)
      .run(legacyWorkspaceId, legacyUserId, appliedAt);
    db.prepare(`INSERT INTO legacy_claims
      (workspace_id,owner_user_id,state,attempt_hash,pending_session_id,pending_expires_at,updated_at)
      VALUES (?, ?, 'open', NULL, NULL, NULL, ?)`)
      .run(legacyWorkspaceId, legacyUserId, appliedAt);

    db.prepare(`INSERT INTO categories_new
      (workspace_id,id,name,placement,sort_order,color,version,created_at,updated_at,archived_at)
      SELECT ?,id,name,placement,sort_order,color,version,created_at,updated_at,archived_at FROM categories`)
      .run(legacyWorkspaceId);
    db.prepare(`INSERT INTO expenses_new
      (workspace_id,id,amount_minor,currency,category_id,occurred_at,note,version,created_at,updated_at,deleted_at)
      SELECT ?,id,amount_minor,currency,category_id,occurred_at,note,version,created_at,updated_at,deleted_at FROM expenses`)
      .run(legacyWorkspaceId);
    db.prepare(`INSERT INTO sync_operations_new(workspace_id,operation_id,result_json,created_at)
      SELECT ?,operation_id,result_json,created_at FROM sync_operations`).run(legacyWorkspaceId);
  }

  db.exec(`
    DROP TABLE expenses;
    DROP TABLE sync_operations;
    DROP TABLE categories;
    ALTER TABLE categories_new RENAME TO categories;
    ALTER TABLE expenses_new RENAME TO expenses;
    ALTER TABLE sync_operations_new RENAME TO sync_operations;
    CREATE INDEX categories_order_idx ON categories(workspace_id, placement, sort_order);
    CREATE INDEX categories_archived_idx ON categories(workspace_id, archived_at);
    CREATE INDEX expenses_occurred_idx ON expenses(workspace_id, occurred_at DESC) WHERE deleted_at IS NULL;
    CREATE INDEX expenses_deleted_idx ON expenses(workspace_id, deleted_at);
    CREATE INDEX sync_operations_created_idx ON sync_operations(workspace_id, created_at);
  `);

  assertIntegrity(db, expected);
}

export function seedWorkspaceCategories(db: Database.Database, workspaceId: string): void {
  const insert = db.prepare(`INSERT OR IGNORE INTO categories
    (workspace_id,id,name,placement,sort_order,color,version,created_at,updated_at)
    VALUES (?,?,?,?,?,?,1,?,?)`);
  const now = new Date().toISOString();
  for (const seed of seeds) insert.run(workspaceId, ...seed, now, now);
}

export function openDatabase(path: string): Database.Database {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  try {
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    db.pragma("busy_timeout = 5000");

    const versionAtStartup = schemaVersionAtStartup(db);
    if (versionAtStartup > LATEST_SCHEMA_VERSION) {
      throw new Error(`Database schema version ${versionAtStartup} is newer than supported version ${LATEST_SCHEMA_VERSION}`);
    }
    const wasLegacyInstallation = versionAtStartup === 1 || versionAtStartup === 2;
    const legacyUserId = randomUUID();
    const legacyWorkspaceId = randomUUID();

    const migrate = db.transaction(() => {
      db.exec("CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)");
      for (let i = 0; i < LATEST_SCHEMA_VERSION; i++) {
        const version = i + 1;
        if (db.prepare("SELECT 1 FROM schema_migrations WHERE version = ?").get(version)) continue;
        const appliedAt = new Date().toISOString();
        if (version <= migrations.length) db.exec(migrations[i]!);
        else if (version === 3) migrateToVersion3(db, wasLegacyInstallation, legacyUserId, legacyWorkspaceId, appliedAt);
        else if (version === 4) db.exec("CREATE UNIQUE INDEX IF NOT EXISTS legacy_claims_singleton_idx ON legacy_claims((1))");
        else if (version === 5) db.prepare(`UPDATE categories
          SET name = 'Кафе и рестораны', version = version + 1, updated_at = ?
          WHERE id = 'eating-out' AND name = 'Eating out' COLLATE NOCASE
            AND NOT EXISTS (
              SELECT 1 FROM categories AS conflicting
              WHERE conflicting.workspace_id = categories.workspace_id
                AND conflicting.id <> categories.id
                AND conflicting.name = 'Кафе и рестораны' COLLATE NOCASE
            )`).run(appliedAt);
        else if (version === 6) db.exec(`
          CREATE TABLE oauth_clients (
            client_id TEXT PRIMARY KEY,
            redirect_uris_json TEXT NOT NULL CHECK(json_valid(redirect_uris_json)),
            client_name TEXT NOT NULL CHECK(length(client_name) BETWEEN 1 AND 100),
            created_at TEXT NOT NULL
          );
          CREATE TABLE oauth_authorization_codes (
            code_hash TEXT PRIMARY KEY,
            client_id TEXT NOT NULL REFERENCES oauth_clients(client_id),
            user_id TEXT NOT NULL REFERENCES users(id),
            redirect_uri TEXT NOT NULL,
            scope TEXT NOT NULL,
            code_challenge TEXT NOT NULL,
            resource TEXT NOT NULL,
            created_at TEXT NOT NULL,
            expires_at TEXT NOT NULL,
            consumed_at TEXT
          );
          CREATE INDEX oauth_codes_expiry_idx ON oauth_authorization_codes(expires_at);
          CREATE TABLE oauth_tokens (
            access_token_hash TEXT PRIMARY KEY,
            refresh_token_hash TEXT UNIQUE NOT NULL,
            client_id TEXT NOT NULL REFERENCES oauth_clients(client_id),
            user_id TEXT NOT NULL REFERENCES users(id),
            scope TEXT NOT NULL,
            resource TEXT NOT NULL,
            created_at TEXT NOT NULL,
            access_expires_at TEXT NOT NULL,
            refresh_expires_at TEXT NOT NULL,
            revoked_at TEXT
          );
          CREATE INDEX oauth_tokens_user_idx ON oauth_tokens(user_id,created_at);
          CREATE INDEX oauth_tokens_access_expiry_idx ON oauth_tokens(access_expires_at);
          CREATE INDEX oauth_tokens_refresh_expiry_idx ON oauth_tokens(refresh_expires_at);
        `);
        else if (version === 7) db.exec(`
          CREATE TABLE bybit_card_connections (
            id TEXT PRIMARY KEY,
            workspace_id TEXT NOT NULL UNIQUE REFERENCES workspaces(id) ON DELETE CASCADE,
            connected_by_user_id TEXT NOT NULL REFERENCES users(id),
            credentials_encrypted TEXT NOT NULL,
            region TEXT NOT NULL,
            enabled_at TEXT NOT NULL,
            last_synced_at TEXT,
            status TEXT NOT NULL CHECK(status IN ('active','error')),
            last_error TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
          );
          CREATE INDEX bybit_card_connections_status_idx ON bybit_card_connections(status,last_synced_at);
          CREATE TABLE bybit_card_transactions (
            id TEXT PRIMARY KEY,
            connection_id TEXT NOT NULL REFERENCES bybit_card_connections(id) ON DELETE CASCADE,
            workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
            external_key TEXT NOT NULL,
            txn_id TEXT,
            order_no TEXT,
            side TEXT NOT NULL,
            trade_status TEXT NOT NULL,
            provider_status TEXT NOT NULL,
            amount_minor INTEGER NOT NULL CHECK(amount_minor > 0),
            currency TEXT NOT NULL CHECK(length(currency)=3),
            merchant_name TEXT,
            merchant_country TEXT,
            merchant_city TEXT,
            mcc_code TEXT,
            merchant_category TEXT,
            occurred_at TEXT NOT NULL,
            review_status TEXT NOT NULL CHECK(review_status IN ('pending','classified','ignored')),
            expense_id TEXT,
            raw_json TEXT NOT NULL CHECK(json_valid(raw_json)),
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            UNIQUE(connection_id,external_key)
          );
          CREATE INDEX bybit_card_transactions_review_idx ON bybit_card_transactions(workspace_id,review_status,occurred_at);
          CREATE INDEX bybit_card_transactions_expense_idx ON bybit_card_transactions(workspace_id,expense_id);
        `);
        else if (version === 8) db.exec(`
          CREATE TABLE tags (
            workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
            id TEXT NOT NULL,
            name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 30),
            name_key TEXT NOT NULL,
            version INTEGER NOT NULL DEFAULT 1,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            PRIMARY KEY(workspace_id, id),
            UNIQUE(workspace_id, name_key)
          );
          CREATE TABLE expense_tags (
            workspace_id TEXT NOT NULL,
            expense_id TEXT NOT NULL,
            tag_id TEXT NOT NULL,
            PRIMARY KEY(workspace_id, expense_id, tag_id),
            FOREIGN KEY(workspace_id, expense_id) REFERENCES expenses(workspace_id, id) ON DELETE CASCADE,
            FOREIGN KEY(workspace_id, tag_id) REFERENCES tags(workspace_id, id) ON DELETE CASCADE
          );
          CREATE INDEX expense_tags_tag_idx ON expense_tags(workspace_id, tag_id);
        `);
        db.prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)").run(version, appliedAt);
      }
    });
    migrate();
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

export function startBackupHeartbeat(db: Database.Database): () => void {
  const write = () => db.prepare(`INSERT INTO app_meta(key,value) VALUES ('backup_heartbeat',?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(new Date().toISOString());
  write();
  const timer = setInterval(write, 6 * 60 * 60 * 1000);
  timer.unref();
  return () => clearInterval(timer);
}
