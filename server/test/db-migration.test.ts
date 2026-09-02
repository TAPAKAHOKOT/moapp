import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import Database from "better-sqlite3";
import { openDatabase, seedWorkspaceCategories } from "../src/db.js";

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
    assert.equal((db.prepare("SELECT max(version) AS version FROM schema_migrations").get() as { version: number }).version, 8);
    for (const table of ["users", "workspaces", "memberships", "categories", "legacy_claims", "oauth_clients", "oauth_authorization_codes", "oauth_tokens", "bybit_card_connections", "bybit_card_transactions"] as const) {
      assert.equal((db.prepare(`SELECT count(*) AS count FROM ${table}`).get() as { count: number }).count, 0);
    }
    db.close();
    const sizeAfterFirstStart = statSync(fixture.path).size;

    db = openDatabase(fixture.path);
    assert.equal((db.prepare("SELECT count(*) AS count FROM schema_migrations").get() as { count: number }).count, 8);
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
      assert.deepEqual(category, { workspace_id: workspace.id, ...LEGACY_CATEGORY });
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
        deleted_at: null
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
    assert.equal((db.prepare("SELECT max(version) AS version FROM schema_migrations").get() as { version: number }).version, 8);
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
    assert.equal((db.prepare("SELECT max(version) AS version FROM schema_migrations").get() as { version: number }).version, 8);
    assert.equal((db.prepare("SELECT count(*) AS count FROM expenses").get() as { count: number }).count, 2);
    assert.deepEqual(db.pragma("foreign_key_check"), []);
    db.close();
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
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
