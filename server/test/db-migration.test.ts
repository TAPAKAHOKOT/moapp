import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import Database from "better-sqlite3";
import { backfillWorkspaceCurrencies, openDatabase, seedWorkspaceCategories } from "../src/db.js";

const LEGACY_CATEGORY = {
  id: "custom-category",
  name: "Legacy custom",
  placement: "additional",
  sort_order: 17,
  color: "#123456",
  version: 8,
  created_at: "2024-02-03T04:05:06.000Z",
  updated_at: "2025-03-04T05:06:07.000Z",
  archived_at: null
};

function temporaryDatabase(): { directory: string; path: string } {
  const directory = mkdtempSync(join(tmpdir(), "moapp-migration-"));
  return { directory, path: join(directory, "moapp.sqlite") };
}

function createLegacyFixture(path: string, version: 1 | 2, populated: boolean, invalidExpense = false): void {
  const db = new Database(path);
  // This switch is used only by the failure-atomicity fixture to model a damaged
  // source row which makes the v3 copy fail after its temporary tables exist.
  if (invalidExpense) db.pragma("foreign_keys = OFF");
  db.exec(`
    CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
    INSERT INTO schema_migrations(version,applied_at) VALUES (1,'2025-01-01T00:00:00.000Z');
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
      ${version === 2 ? ", pin_fingerprint TEXT" : ""}
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
  `);
  if (version === 2) {
    db.exec(`
      INSERT INTO schema_migrations(version,applied_at) VALUES (2,'2025-01-02T00:00:00.000Z');
      CREATE TABLE app_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
    `);
  }
  if (populated) {
    const insertCategory = db.prepare(`INSERT INTO categories
      (id,name,placement,sort_order,color,version,created_at,updated_at,archived_at)
      VALUES (@id,@name,@placement,@sort_order,@color,@version,@created_at,@updated_at,@archived_at)`);
    insertCategory.run({
      ...LEGACY_CATEGORY,
      id: "products",
      name: "Продукты",
      placement: "main",
      sort_order: 0,
      color: "#7CB98B",
      version: 2
    });
    insertCategory.run({ ...LEGACY_CATEGORY });
    insertCategory.run({
      ...LEGACY_CATEGORY,
      id: "archived-category",
      name: "Archived legacy",
      sort_order: 18,
      version: 3,
      archived_at: "2025-04-05T06:07:08.000Z"
    });
    db.prepare(`INSERT INTO expenses
      (id,amount_minor,currency,category_id,occurred_at,note,version,created_at,updated_at,deleted_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
      "active-expense", 12345, "RSD", invalidExpense ? "missing-category" : LEGACY_CATEGORY.id,
      "2025-05-06T07:08:09.000Z", "preserve me", 6,
      "2025-05-06T07:08:10.000Z", "2025-05-07T08:09:10.000Z", null
    );
    db.prepare(`INSERT INTO expenses
      (id,amount_minor,currency,category_id,occurred_at,note,version,created_at,updated_at,deleted_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
      "deleted-expense", 999, "EUR", "archived-category", "2025-06-07T08:09:10.000Z", null, 11,
      "2025-06-07T08:09:11.000Z", "2025-06-08T09:10:11.000Z", "2025-06-09T10:11:12.000Z"
    );
    db.prepare("INSERT INTO sync_operations(operation_id,result_json,created_at) VALUES (?,?,?)")
      .run("legacy-operation", '{"status":"applied","nested":{"value":7}}', "2025-07-08T09:10:11.000Z");
    if (version === 2) {
      db.prepare("INSERT INTO sessions(token_hash,expires_at,created_at,pin_fingerprint) VALUES (?,?,?,?)")
        .run("old-session-hash", "2030-01-01T00:00:00.000Z", "2025-01-01T00:00:00.000Z", "pin-hash");
    } else {
      db.prepare("INSERT INTO sessions(token_hash,expires_at,created_at) VALUES (?,?,?)")
        .run("old-session-hash", "2030-01-01T00:00:00.000Z", "2025-01-01T00:00:00.000Z");
    }
  }
  db.close();
}

function createWorkspace(db: Database.Database, workspaceId: string, userId: string, name: string): void {
  const now = "2026-01-01T00:00:00.000Z";
  db.transaction(() => {
    db.prepare("INSERT OR IGNORE INTO users(id,display_name,created_at,updated_at) VALUES (?,?,?,?)")
      .run(userId, "Test owner", now, now);
    db.prepare("INSERT INTO workspaces(id,name,owner_user_id,created_at,updated_at) VALUES (?,?,?,?,?)")
      .run(workspaceId, name, userId, now, now);
    db.prepare("INSERT INTO memberships(workspace_id,user_id,joined_at) VALUES (?,?,?)")
      .run(workspaceId, userId, now);
  })();
}

test("a clean file reaches the latest schema without hidden identity, workspace, categories, or claim", () => {
  const fixture = temporaryDatabase();
  try {
    let db = openDatabase(fixture.path);
    assert.equal((db.prepare("SELECT max(version) AS version FROM schema_migrations").get() as { version: number }).version, 17);
    for (const table of ["users", "workspaces", "memberships", "categories", "legacy_claims", "oauth_clients", "oauth_authorization_codes", "oauth_tokens", "bybit_card_connections", "card_transactions", "workspace_mods", "user_settings", "member_settings"] as const) {
      assert.equal((db.prepare(`SELECT count(*) AS count FROM ${table}`).get() as { count: number }).count, 0);
    }
    db.close();
    const sizeAfterFirstStart = statSync(fixture.path).size;

    db = openDatabase(fixture.path);
    assert.equal((db.prepare("SELECT count(*) AS count FROM schema_migrations").get() as { count: number }).count, 17);
    assert.equal((db.prepare("SELECT count(*) AS count FROM users").get() as { count: number }).count, 0);
    assert.equal(statSync(fixture.path).size, sizeAfterFirstStart);
    db.close();
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

for (const version of [1, 2] as const) {
  test(`an existing populated v${version} file is losslessly moved into one legacy workspace`, () => {
    const fixture = temporaryDatabase();
    try {
      createLegacyFixture(fixture.path, version, true);
      const sizeBefore = statSync(fixture.path).size;
      let db = openDatabase(fixture.path);
      const workspace = db.prepare("SELECT * FROM workspaces").get() as Record<string, unknown>;
      const user = db.prepare("SELECT * FROM users").get() as Record<string, unknown>;
      const claim = db.prepare("SELECT * FROM legacy_claims").get() as Record<string, unknown>;
      assert.equal(workspace.name, "Основное");
      assert.equal(workspace.owner_user_id, user.id);
      assert.equal(workspace.currency, "RSD", "the legacy workspace takes the currency of its only active expense");
      assert.deepEqual(claim, {
        workspace_id: workspace.id,
        owner_user_id: user.id,
        state: "open",
        attempt_hash: null,
        pending_session_id: null,
        pending_expires_at: null,
        updated_at: claim.updated_at
      });
      assert.match(String(workspace.id), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      assert.equal((db.prepare("SELECT count(*) AS count FROM memberships").get() as { count: number }).count, 1);
      assert.equal((db.prepare("SELECT count(*) AS count FROM sessions").get() as { count: number }).count, 0);

      const category = db.prepare("SELECT * FROM categories WHERE workspace_id=? AND id=?")
        .get(workspace.id, LEGACY_CATEGORY.id) as Record<string, unknown>;
      assert.deepEqual(category, { workspace_id: workspace.id, ...LEGACY_CATEGORY, emoji: null });
      assert.equal((db.prepare("SELECT version FROM categories WHERE workspace_id=? AND id='products'")
        .get(workspace.id) as { version: number }).version, 2);
      const activeExpense = db.prepare("SELECT * FROM expenses WHERE workspace_id=? AND id='active-expense'")
        .get(workspace.id) as Record<string, unknown>;
      assert.deepEqual(activeExpense, {
        workspace_id: workspace.id,
        id: "active-expense",
        amount_minor: 12345,
        currency: "RSD",
        category_id: LEGACY_CATEGORY.id,
        occurred_at: "2025-05-06T07:08:09.000Z",
        note: "preserve me",
        version: 6,
        created_at: "2025-05-06T07:08:10.000Z",
        updated_at: "2025-05-07T08:09:10.000Z",
        deleted_at: null,
        voided_at: null,
        void_reason: null,
        source_transaction_id: null
      });
      assert.equal((db.prepare("SELECT deleted_at FROM expenses WHERE id='deleted-expense'").get() as { deleted_at: string }).deleted_at,
        "2025-06-09T10:11:12.000Z");
      assert.equal((db.prepare("SELECT result_json FROM sync_operations").get() as { result_json: string }).result_json,
        '{"status":"applied","nested":{"value":7}}');
      assert.deepEqual(db.pragma("foreign_key_check"), []);
      assert.deepEqual(db.pragma("quick_check"), [{ quick_check: "ok" }]);

      const indexes = new Set((db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all() as { name: string }[]).map(({ name }) => name));
      for (const name of [
        "memberships_user_idx", "sessions_user_idx", "sessions_expiry_idx", "sessions_active_idx",
        "access_tokens_kind_idx", "access_tokens_target_idx", "access_tokens_workspace_idx", "access_tokens_expiry_idx",
        "categories_order_idx", "categories_archived_idx", "expenses_occurred_idx", "expenses_deleted_idx", "sync_operations_created_idx",
        "oauth_codes_expiry_idx", "oauth_tokens_user_idx", "oauth_tokens_access_expiry_idx", "oauth_tokens_refresh_expiry_idx"
      ]) assert.ok(indexes.has(name), `missing index ${name}`);
      const expenseForeignKey = db.pragma("foreign_key_list(expenses)") as { from: string; to: string; table: string }[];
      assert.deepEqual(expenseForeignKey.filter(({ table }) => table === "categories").map(({ from, to }) => [from, to]),
        [["workspace_id", "workspace_id"], ["category_id", "id"]]);

      const ids = { workspaceId: workspace.id, userId: user.id };
      const sizeAfter = statSync(fixture.path).size;
      assert.ok(sizeAfter < sizeBefore * 4, `fixture migration unexpectedly grew from ${sizeBefore} to ${sizeAfter} bytes`);
      db.close();

      db = openDatabase(fixture.path);
      assert.deepEqual(db.prepare("SELECT id AS workspaceId,owner_user_id AS userId FROM workspaces").get(), ids);
      assert.equal((db.prepare("SELECT count(*) AS count FROM legacy_claims").get() as { count: number }).count, 1);
      db.close();
    } finally {
      rmSync(fixture.directory, { recursive: true, force: true });
    }
  });
}

for (const version of [1, 2] as const) {
  test(`an already-versioned but empty v${version} file is still a legacy installation`, () => {
    const fixture = temporaryDatabase();
    try {
      createLegacyFixture(fixture.path, version, false);
      const db = openDatabase(fixture.path);
      assert.equal((db.prepare("SELECT count(*) AS count FROM workspaces").get() as { count: number }).count, 1);
      assert.equal((db.prepare("SELECT count(*) AS count FROM legacy_claims WHERE state='open'").get() as { count: number }).count, 1);
      assert.equal((db.prepare("SELECT count(*) AS count FROM categories").get() as { count: number }).count, 0);
      db.close();
    } finally {
      rmSync(fixture.directory, { recursive: true, force: true });
    }
  });
}

test("tenant composite keys allow same IDs but reject cross-workspace category references", () => {
  const fixture = temporaryDatabase();
  try {
    const db = openDatabase(fixture.path);
    const userId = randomUUID();
    const workspaceA = randomUUID();
    const workspaceB = randomUUID();
    createWorkspace(db, workspaceA, userId, "A");
    createWorkspace(db, workspaceB, userId, "B");
    seedWorkspaceCategories(db, workspaceA);
    seedWorkspaceCategories(db, workspaceB);
    assert.equal((db.prepare("SELECT count(*) AS count FROM categories WHERE id='products'").get() as { count: number }).count, 2);

    const insertExpense = db.prepare(`INSERT INTO expenses
      (workspace_id,id,amount_minor,currency,category_id,occurred_at,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?)`);
    const now = "2026-02-01T00:00:00.000Z";
    insertExpense.run(workspaceA, "same-expense", 1, "RSD", "products", now, now, now);
    insertExpense.run(workspaceB, "same-expense", 2, "RSD", "products", now, now, now);
    db.prepare("INSERT INTO categories(workspace_id,id,name,placement,created_at,updated_at) VALUES (?,?,?,?,?,?)")
      .run(workspaceB, "only-in-b", "Only in B", "additional", now, now);
    assert.throws(() => insertExpense.run(workspaceA, "cross-tenant", 3, "RSD", "only-in-b", now, now, now), /FOREIGN KEY/);

    const insertOperation = db.prepare("INSERT INTO sync_operations(workspace_id,operation_id,result_json,created_at) VALUES (?,?,?,?)");
    insertOperation.run(workspaceA, "same-operation", "{}", now);
    insertOperation.run(workspaceB, "same-operation", "{}", now);
    assert.throws(() => insertOperation.run(workspaceA, "same-operation", "{}", now), /UNIQUE/);
    db.close();
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test("v5 localizes only the untouched default eating-out category", () => {
  const fixture = temporaryDatabase();
  try {
    let db = openDatabase(fixture.path);
    const userId = randomUUID();
    const workspaceA = randomUUID();
    const workspaceB = randomUUID();
    const workspaceC = randomUUID();
    createWorkspace(db, workspaceA, userId, "A");
    createWorkspace(db, workspaceB, userId, "B");
    createWorkspace(db, workspaceC, userId, "C");
    seedWorkspaceCategories(db, workspaceA);
    seedWorkspaceCategories(db, workspaceB);
    seedWorkspaceCategories(db, workspaceC);

    assert.equal(db.prepare("SELECT name FROM categories WHERE workspace_id=? AND id='eating-out'")
      .pluck().get(workspaceA), "Кафе и рестораны");

    const oldUpdatedAt = "2025-01-01T00:00:00.000Z";
    db.prepare("UPDATE categories SET name='Eating out',version=6,updated_at=? WHERE workspace_id=? AND id='eating-out'")
      .run(oldUpdatedAt, workspaceA);
    db.prepare("UPDATE categories SET name='Бранч',version=3 WHERE workspace_id=? AND id='eating-out'")
      .run(workspaceB);
    db.prepare("UPDATE categories SET name='Eating out',version=4 WHERE workspace_id=? AND id='eating-out'")
      .run(workspaceC);
    db.prepare(`INSERT INTO categories
      (workspace_id,id,name,placement,sort_order,color,version,created_at,updated_at)
      VALUES (?, 'custom-restaurants', 'Кафе и рестораны', 'additional', 20, NULL, 1, ?, ?)`)
      .run(workspaceC, oldUpdatedAt, oldUpdatedAt);
    db.prepare("DELETE FROM schema_migrations WHERE version=5").run();
    db.close();

    db = openDatabase(fixture.path);
    const localized = db.prepare("SELECT name,version,updated_at FROM categories WHERE workspace_id=? AND id='eating-out'")
      .get(workspaceA) as { name: string; version: number; updated_at: string };
    assert.equal(localized.name, "Кафе и рестораны");
    assert.equal(localized.version, 7);
    assert.notEqual(localized.updated_at, oldUpdatedAt);
    assert.deepEqual(db.prepare("SELECT name,version FROM categories WHERE workspace_id=? AND id='eating-out'").get(workspaceB), {
      name: "Бранч",
      version: 3
    });
    assert.deepEqual(db.prepare("SELECT name,version FROM categories WHERE workspace_id=? AND id='eating-out'").get(workspaceC), {
      name: "Eating out",
      version: 4
    });
    assert.equal(db.prepare("SELECT count(*) FROM categories WHERE workspace_id=? AND name='Кафе и рестораны'")
      .pluck().get(workspaceC), 1);
    db.close();

    db = openDatabase(fixture.path);
    assert.equal(db.prepare("SELECT version FROM categories WHERE workspace_id=? AND id='eating-out'")
      .pluck().get(workspaceA), 7);
    db.close();
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test("access token purpose constraints reject hybrid recovery and cross-user device rows", () => {
  const fixture = temporaryDatabase();
  try {
    const db = openDatabase(fixture.path);
    const ownerId = randomUUID();
    const otherUserId = randomUUID();
    const workspaceId = randomUUID();
    const now = "2026-02-01T00:00:00.000Z";
    createWorkspace(db, workspaceId, ownerId, "A");
    db.prepare("INSERT INTO users(id,display_name,created_at,updated_at) VALUES (?,?,?,?)")
      .run(otherUserId, "Other", now, now);
    const sessionId = randomUUID();
    db.prepare(`INSERT INTO sessions
      (id,token_hash,user_id,kind,label,created_at,last_seen_at,expires_at)
      VALUES (?,?,?,'normal','Test',?,?,?)`)
      .run(sessionId, "session-hash", ownerId, now, now, "2027-02-01T00:00:00.000Z");

    const insert = db.prepare(`INSERT INTO access_tokens
      (id,kind,token_hash,workspace_id,target_user_id,created_by_user_id,created_by_session_id,
       replacement_token_hash,expected_generation,revoke_sessions,accept_attempt_hash,
       accepted_session_id,created_at,expires_at,consumed_at,revoked_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL,NULL)`);

    assert.throws(() => insert.run(
      randomUUID(), "recovery_rotation", "hybrid-recovery", null, ownerId, null,
      sessionId, "replacement-hash", 0, 0, null, null, now, "2026-02-01T00:30:00.000Z"
    ), /CHECK constraint failed/);
    assert.throws(() => insert.run(
      randomUUID(), "device_link", "cross-user-device", null, otherUserId, ownerId,
      sessionId, null, null, 0, null, null, now, "2026-02-01T00:15:00.000Z"
    ), /CHECK constraint failed/);

    db.close();
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test("legacy claim storage remains a singleton", () => {
  const fixture = temporaryDatabase();
  try {
    const db = openDatabase(fixture.path);
    const userId = randomUUID();
    const secondUserId = randomUUID();
    const workspaceId = randomUUID();
    const secondWorkspaceId = randomUUID();
    const now = "2026-02-01T00:00:00.000Z";
    createWorkspace(db, workspaceId, userId, "A");
    createWorkspace(db, secondWorkspaceId, secondUserId, "B");
    const insert = db.prepare(`INSERT INTO legacy_claims
      (workspace_id,owner_user_id,state,attempt_hash,pending_session_id,pending_expires_at,updated_at)
      VALUES (?,?,'open',NULL,NULL,NULL,?)`);
    insert.run(workspaceId, userId, now);
    assert.throws(() => insert.run(secondWorkspaceId, secondUserId, now), /UNIQUE/);
    db.close();
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test("an existing v3 database receives the singleton hardening migration", () => {
  const fixture = temporaryDatabase();
  try {
    let db = openDatabase(fixture.path);
    db.exec("DROP INDEX legacy_claims_singleton_idx; DELETE FROM schema_migrations WHERE version=4");
    db.close();

    db = openDatabase(fixture.path);
    assert.equal((db.prepare("SELECT max(version) AS version FROM schema_migrations").get() as { version: number }).version, 17);
    assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name='legacy_claims_singleton_idx'").get());
    db.close();
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test("a copy failure rolls v3 back and leaves a retryable v2 database", () => {
  const fixture = temporaryDatabase();
  try {
    createLegacyFixture(fixture.path, 2, true, true);
    assert.throws(() => openDatabase(fixture.path), /FOREIGN KEY/);

    let db = new Database(fixture.path);
    assert.equal((db.prepare("SELECT max(version) AS version FROM schema_migrations").get() as { version: number }).version, 2);
    assert.equal((db.prepare("SELECT count(*) AS count FROM expenses").get() as { count: number }).count, 2);
    assert.equal((db.prepare("SELECT count(*) AS count FROM sessions").get() as { count: number }).count, 1);
    assert.equal((db.prepare("SELECT count(*) AS count FROM sqlite_master WHERE type='table' AND name='workspaces'").get() as { count: number }).count, 0);
    db.prepare(`INSERT INTO categories
      (id,name,placement,sort_order,color,version,created_at,updated_at,archived_at)
      VALUES ('missing-category','Repaired','additional',19,NULL,1,'2025-01-01','2025-01-01',NULL)`).run();
    db.close();

    db = openDatabase(fixture.path);
    assert.equal((db.prepare("SELECT max(version) AS version FROM schema_migrations").get() as { version: number }).version, 17);
    assert.equal((db.prepare("SELECT count(*) AS count FROM expenses").get() as { count: number }).count, 2);
    assert.deepEqual(db.pragma("foreign_key_check"), []);
    db.close();
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test("the schema-11 backfill gives a workspace its most used currency and leaves an empty one in dinars", () => {
  const db = openDatabase(":memory:");
  try {
    const owner = randomUUID();
    const [euro, tie, empty] = [randomUUID(), randomUUID(), randomUUID()];
    for (const [id, name] of [[euro, "Euro"], [tie, "Tie"], [empty, "Empty"]] as const) {
      createWorkspace(db, id, owner, name);
      seedWorkspaceCategories(db, id);
    }
    const insert = db.prepare(`INSERT INTO expenses(workspace_id,id,amount_minor,currency,category_id,occurred_at,note,version,created_at,updated_at,deleted_at)
      VALUES (?,?,100,?,'products',?,NULL,1,?,?,?)`);
    const add = (workspaceId: string, currency: string, occurredAt: string, deletedAt: string | null = null) =>
      insert.run(workspaceId, randomUUID(), currency, occurredAt, occurredAt, occurredAt, deletedAt);
    add(euro, "EUR", "2026-03-01T10:00:00.000Z");
    add(euro, "EUR", "2026-03-02T10:00:00.000Z");
    add(euro, "RSD", "2026-03-03T10:00:00.000Z");
    for (let index = 0; index < 5; index += 1) add(euro, "USD", "2026-03-04T10:00:00.000Z", "2026-03-05T10:00:00.000Z");
    add(tie, "RSD", "2026-01-01T10:00:00.000Z");
    add(tie, "USD", "2026-02-01T10:00:00.000Z");
    db.prepare("UPDATE workspaces SET currency='XXX'").run();

    backfillWorkspaceCurrencies(db);

    const currency = (id: string) => db.prepare("SELECT currency FROM workspaces WHERE id=?").pluck().get(id);
    assert.equal(currency(euro), "EUR", "deleted records do not count");
    assert.equal(currency(tie), "USD", "a tie goes to the more recent purchase");
    assert.equal(currency(empty), "RSD");
  } finally {
    db.close();
  }
});

test("a schema newer than this server fails before migrations run", () => {
  const fixture = temporaryDatabase();
  try {
    const db = new Database(fixture.path);
    db.exec("CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,applied_at TEXT NOT NULL); INSERT INTO schema_migrations VALUES (99,'now')");
    db.close();
    assert.throws(() => openDatabase(fixture.path), /newer than supported/);
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test("schemas 14 and 15 move Bybit operations, split parts included, into the shared card queue", () => {
  const fixture = temporaryDatabase();
  try {
    let db = openDatabase(fixture.path);
    const userId = randomUUID();
    const workspaceId = randomUUID();
    createWorkspace(db, workspaceId, userId, "Cards");
    const now = "2026-09-01T10:00:00.000Z";
    db.prepare(`INSERT INTO bybit_card_connections
      (id,workspace_id,connected_by_user_id,credentials_encrypted,region,enabled_at,last_synced_at,status,last_error,created_at,updated_at)
      VALUES ('connection',?,?,'v1:x:y:z','global',?,NULL,'active',NULL,?,?)`).run(workspaceId, userId, now, now, now);
    /* Схема 13 как есть: таблица Bybit с разделёнными частями, и миграции 14 и 15 ещё не применялись. */
    db.exec(`DROP TABLE card_transactions; DROP TABLE workspace_mods; DELETE FROM schema_migrations WHERE version IN (14,15);
      CREATE TABLE bybit_card_transactions (
        id TEXT PRIMARY KEY,
        connection_id TEXT NOT NULL REFERENCES bybit_card_connections(id) ON DELETE CASCADE,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        external_key TEXT NOT NULL, txn_id TEXT, order_no TEXT, side TEXT NOT NULL, trade_status TEXT NOT NULL, provider_status TEXT NOT NULL,
        amount_minor INTEGER NOT NULL CHECK(amount_minor > 0), currency TEXT NOT NULL CHECK(length(currency)=3),
        merchant_name TEXT, merchant_country TEXT, merchant_city TEXT, mcc_code TEXT, merchant_category TEXT, occurred_at TEXT NOT NULL,
        review_status TEXT NOT NULL CHECK(review_status IN ('pending','classified','ignored','split')), expense_id TEXT,
        split_of_id TEXT REFERENCES bybit_card_transactions(id) ON DELETE CASCADE,
        split_index INTEGER NOT NULL DEFAULT 0 CHECK(split_index >= 0),
        raw_json TEXT NOT NULL CHECK(json_valid(raw_json)), created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        UNIQUE(connection_id,external_key),
        CHECK((split_of_id IS NULL AND split_index = 0) OR (split_of_id IS NOT NULL AND split_index > 0))
      );`);
    const insert = db.prepare(`INSERT INTO bybit_card_transactions
      (id,connection_id,workspace_id,external_key,side,trade_status,provider_status,amount_minor,currency,merchant_name,occurred_at,
        review_status,split_of_id,split_index,raw_json,created_at,updated_at)
      VALUES (?,'connection',?,?,'1','1','1',?,'RSD',?,?,?,?,?,'{}',?,?)`);
    insert.run("whole", workspaceId, "1:whole", 1000, "Shop", now, "pending", null, 0, now, now);
    insert.run("parent", workspaceId, "1:parent", 3000, "Market", now, "split", null, 0, now, now);
    insert.run("part-1", workspaceId, "1:parent#1", 1000, "Market", now, "classified", "parent", 1, now, now);
    insert.run("part-2", workspaceId, "1:parent#2", 2000, "Market", now, "pending", "parent", 2, now, now);
    db.close();

    db = openDatabase(fixture.path);
    assert.equal((db.prepare("SELECT max(version) AS version FROM schema_migrations").get() as { version: number }).version, 17);
    assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='bybit_card_transactions'").get(), undefined);
    assert.deepEqual(db.prepare("SELECT id,source,connection_id,external_key,review_status,split_of_id,split_index FROM card_transactions ORDER BY id").all(), [
      { id: "parent", source: "bybit-card", connection_id: "connection", external_key: "1:parent", review_status: "split", split_of_id: null, split_index: 0 },
      { id: "part-1", source: "bybit-card", connection_id: "connection", external_key: "1:parent#1", review_status: "classified", split_of_id: "parent", split_index: 1 },
      { id: "part-2", source: "bybit-card", connection_id: "connection", external_key: "1:parent#2", review_status: "pending", split_of_id: "parent", split_index: 2 },
      { id: "whole", source: "bybit-card", connection_id: "connection", external_key: "1:whole", review_status: "pending", split_of_id: null, split_index: 0 }
    ]);
    assert.deepEqual(db.pragma("foreign_key_check"), []);
    assert.deepEqual(db.prepare("SELECT workspace_id,mod_id,added_by_user_id FROM workspace_mods").all(),
      [{ workspace_id: workspaceId, mod_id: "bybit-card", added_by_user_id: userId }], "the connected card becomes an added mod");
    /* Отключённый ключ больше не уносит операции: разобранные и неразобранные остаются в очереди без подключения. */
    db.prepare("DELETE FROM bybit_card_connections WHERE id='connection'").run();
    assert.deepEqual(db.prepare("SELECT id,connection_id,review_status FROM card_transactions ORDER BY id").all(), [
      { id: "parent", connection_id: null, review_status: "split" },
      { id: "part-1", connection_id: null, review_status: "classified" },
      { id: "part-2", connection_id: null, review_status: "pending" },
      { id: "whole", connection_id: null, review_status: "pending" }
    ]);
    db.close();
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

/*
 * Схема 15 добавляет пространству моды, которыми в нём уже пользовались: подключённую карту Bybit и загруженные
 * выписки Т‑Банка. Ключ человека, который уже вышел из пространства, отключается, а его операции остаются.
 */
test("schema 15 adds the mods a workspace already uses and forgets the key of someone who left", () => {
  const fixture = temporaryDatabase();
  try {
    let db = openDatabase(fixture.path);
    const [bybitOwner, statementOwner, idleOwner, oldOwner, departed] = [randomUUID(), randomUUID(), randomUUID(), randomUUID(), randomUUID()];
    const [withCard, withStatements, idle, withDepartedKey] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
    createWorkspace(db, withCard, bybitOwner, "Card");
    createWorkspace(db, withStatements, statementOwner, "Statements");
    createWorkspace(db, idle, idleOwner, "Idle");
    createWorkspace(db, withDepartedKey, oldOwner, "Departed");
    const now = "2026-09-20T10:00:00.000Z";
    db.prepare("INSERT INTO users(id,display_name,created_at,updated_at) VALUES (?,?,?,?)").run(departed, "Gone", now, now);
    /* Схема 14 как есть: очередь с перечнем источников и каскадом от подключения, модов ещё нет. */
    db.exec(`DROP TABLE card_transactions; DROP TABLE workspace_mods; DELETE FROM schema_migrations WHERE version=15;
      CREATE TABLE card_transactions (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        source TEXT NOT NULL CHECK(source IN ('bybit-card','tbank')),
        connection_id TEXT REFERENCES bybit_card_connections(id) ON DELETE CASCADE,
        external_key TEXT NOT NULL, txn_id TEXT, order_no TEXT, side TEXT NOT NULL, trade_status TEXT NOT NULL, provider_status TEXT NOT NULL,
        amount_minor INTEGER NOT NULL CHECK(amount_minor > 0), currency TEXT NOT NULL CHECK(length(currency)=3),
        merchant_name TEXT, merchant_country TEXT, merchant_city TEXT, mcc_code TEXT, merchant_category TEXT, occurred_at TEXT NOT NULL,
        review_status TEXT NOT NULL CHECK(review_status IN ('pending','classified','ignored','split')), expense_id TEXT,
        split_of_id TEXT REFERENCES card_transactions(id) ON DELETE CASCADE,
        split_index INTEGER NOT NULL DEFAULT 0 CHECK(split_index >= 0),
        raw_json TEXT NOT NULL CHECK(json_valid(raw_json)), created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        UNIQUE(workspace_id,source,external_key),
        CHECK((source = 'bybit-card') = (connection_id IS NOT NULL)),
        CHECK((split_of_id IS NULL AND split_index = 0) OR (split_of_id IS NOT NULL AND split_index > 0))
      );`);
    const connect = db.prepare(`INSERT INTO bybit_card_connections
      (id,workspace_id,connected_by_user_id,credentials_encrypted,region,enabled_at,last_synced_at,status,last_error,created_at,updated_at)
      VALUES (?,?,?,'v1:x:y:z','global',?,NULL,'active',NULL,?,?)`);
    connect.run("card-key", withCard, bybitOwner, now, now, now);
    connect.run("departed-key", withDepartedKey, departed, now, now, now);
    const operation = db.prepare(`INSERT INTO card_transactions
      (id,workspace_id,source,connection_id,external_key,side,trade_status,provider_status,amount_minor,currency,occurred_at,review_status,raw_json,created_at,updated_at)
      VALUES (?,?,?,?,?,'1','1','1',100,'RSD',?,'pending','{}',?,?)`);
    operation.run("card-operation", withCard, "bybit-card", "card-key", "1:card", now, now, now);
    operation.run("departed-operation", withDepartedKey, "bybit-card", "departed-key", "1:departed", now, now, now);
    operation.run("later-statement", withStatements, "tbank", null, "*1|2026-09-02T10:00:00|100|RSD#1", now, "2026-09-22T10:00:00.000Z", now);
    operation.run("first-statement", withStatements, "tbank", null, "*1|2026-09-01T10:00:00|100|RSD#1", now, "2026-09-21T10:00:00.000Z", now);
    db.close();

    db = openDatabase(fixture.path);
    assert.equal((db.prepare("SELECT max(version) AS version FROM schema_migrations").get() as { version: number }).version, 17);
    const mods = db.prepare("SELECT workspace_id,mod_id,added_by_user_id,added_at FROM workspace_mods").all() as Array<Record<string, string | null>>;
    const modsOf = (workspaceId: string) => mods.filter((mod) => mod.workspace_id === workspaceId).map(({ workspace_id: _, ...mod }) => mod);
    assert.deepEqual(modsOf(withCard), [{ mod_id: "bybit-card", added_by_user_id: bybitOwner, added_at: now }]);
    assert.deepEqual(modsOf(withStatements), [{ mod_id: "tbank", added_by_user_id: null, added_at: "2026-09-21T10:00:00.000Z" }],
      "the statement mod dates from the first upload");
    assert.deepEqual(modsOf(idle), [], "a workspace that used nothing picks its mods from the catalog");
    assert.deepEqual(modsOf(withDepartedKey), [{ mod_id: "bybit-card", added_by_user_id: departed, added_at: now }], "the mod stays without the key");
    assert.deepEqual(db.prepare("SELECT id FROM bybit_card_connections").pluck().all(), ["card-key"], "a key of someone who left is forgotten");
    assert.deepEqual(db.prepare("SELECT id,connection_id FROM card_transactions WHERE source='bybit-card' ORDER BY id").all(), [
      { id: "card-operation", connection_id: "card-key" },
      { id: "departed-operation", connection_id: null }
    ]);
    assert.deepEqual(db.pragma("foreign_key_check"), []);
    /* Источник операции больше не перечислен в схеме: новый мод обойдётся без миграции. */
    db.prepare(`INSERT INTO card_transactions
      (id,workspace_id,source,connection_id,external_key,side,trade_status,provider_status,amount_minor,currency,occurred_at,review_status,raw_json,created_at,updated_at)
      VALUES ('future',?,'another-bank',NULL,'future#1','debit','1','1',100,'EUR',?,'pending','{}',?,?)`).run(idle, now, now, now);
    /* Человек, которого удалят как «сироту», не держит мод: пометка «кто добавил» просто пустеет. */
    db.prepare("DELETE FROM memberships WHERE user_id=?").run(departed);
    db.prepare("DELETE FROM users WHERE id=?").run(departed);
    assert.equal(db.prepare("SELECT added_by_user_id FROM workspace_mods WHERE workspace_id=?").pluck().get(withDepartedKey), null);
    db.close();
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test("schema 17 gives categories a place for an emoji and leaves every existing category as it was", () => {
  const fixture = temporaryDatabase();
  try {
    let db = openDatabase(fixture.path);
    const [ownerId, workspaceId] = [randomUUID(), randomUUID()];
    createWorkspace(db, workspaceId, ownerId, "Дом");
    seedWorkspaceCategories(db, workspaceId);
    /* Схема 16 как есть: у категорий ещё нет значка, а стартовый список прежних пространств содержал «Вафлю». */
    db.exec("ALTER TABLE categories DROP COLUMN emoji; DELETE FROM schema_migrations WHERE version=17;");
    const now = "2026-09-20T10:00:00.000Z";
    db.prepare(`INSERT INTO categories(workspace_id,id,name,placement,sort_order,color,version,created_at,updated_at)
      VALUES (?,'waffle','Вафля','additional',1,'#D7A0BF',1,?,?)`).run(workspaceId, now, now);
    const before = db.prepare("SELECT * FROM categories WHERE workspace_id=? ORDER BY id").all(workspaceId);
    db.close();

    db = openDatabase(fixture.path);
    assert.equal((db.prepare("SELECT max(version) AS version FROM schema_migrations").get() as { version: number }).version, 17);
    const after = db.prepare("SELECT * FROM categories WHERE workspace_id=? ORDER BY id").all(workspaceId) as Array<Record<string, unknown>>;
    assert.deepEqual(after.map(({ emoji: _, ...row }) => row), before, "names, colours and «Вафля» of an existing workspace stay");
    assert.ok(after.every((row) => row.emoji === null));

    const fresh = randomUUID();
    createWorkspace(db, fresh, ownerId, "Поездка");
    seedWorkspaceCategories(db, fresh);
    assert.deepEqual(db.prepare("SELECT name FROM categories WHERE workspace_id=? ORDER BY placement DESC,sort_order").pluck().all(fresh),
      ["Продукты", "Кафе и рестораны", "Для дома", "Развлечения", "Подписки", "Прочее"], "a new workspace starts without «Вафля»");
    db.close();
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});
