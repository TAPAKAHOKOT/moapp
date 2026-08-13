import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { createSession, sessionCookieName } from "../src/auth.js";
import { seedWorkspaceCategories } from "../src/db.js";
import { buildTestApp, testConfig } from "./test-app.js";

const config = testConfig();
const app = await buildTestApp({ config });
const origin = { origin: config.appOrigin };

before(async () => app.ready());
after(async () => app.close());

function cookieFrom(response: { headers: Record<string, string | string[] | undefined> }): string {
  const value = response.headers["set-cookie"];
  assert.equal(typeof value, "string");
  return value.split(";", 1)[0]!;
}

function context(session: { user: { id: string }; currentSessionId: string }, cookie: string) {
  return {
    cookie,
    "x-moapp-expected-user-id": session.user.id,
    "x-moapp-expected-session-id": session.currentSessionId
  };
}

async function identity(displayName: string) {
  identitySequence += 1;
  const response = await app.inject({ method: "POST", url: "/api/identity", headers: { ...origin, "x-forwarded-for": `192.0.2.${identitySequence}` }, payload: { displayName } });
  assert.equal(response.statusCode, 201, response.body);
  return { session: response.json(), cookie: cookieFrom(response) };
}

let identitySequence = 0;

test("guest bootstrap and identity create only a user and session", async () => {
  const guest = await app.inject({ method: "GET", url: "/api/session" });
  assert.equal(guest.statusCode, 200);
  assert.deepEqual(guest.json().workspaces, []);
  assert.equal(guest.json().authenticated, false);
  assert.equal(app.db.prepare("SELECT count(*) FROM users").pluck().get(), 0);

  const first = await identity("  A\u0301нна  ");
  assert.equal(first.session.authenticated, true);
  assert.equal(first.session.user.displayName, "Áнна");
  assert.equal(app.db.prepare("SELECT count(*) FROM users").pluck().get(), 1);
  assert.equal(app.db.prepare("SELECT count(*) FROM sessions").pluck().get(), 1);
  assert.equal(app.db.prepare("SELECT count(*) FROM workspaces").pluck().get(), 0);

  const replay = await app.inject({ method: "POST", url: "/api/identity", headers: { ...origin, cookie: first.cookie }, payload: { displayName: "Иная" } });
  assert.equal(replay.statusCode, 409);
  assert.equal(replay.json().error.code, "ALREADY_AUTHENTICATED");
});

test("identity creation enforces the hourly per-address limit", async () => {
  const headers = { ...origin, "x-forwarded-for": "198.51.100.77" };
  for (const displayName of ["Rate One", "Rate Two", "Rate Three"]) {
    const response = await app.inject({ method: "POST", url: "/api/identity", headers, payload: { displayName } });
    assert.equal(response.statusCode, 201, response.body);
  }
  const limited = await app.inject({ method: "POST", url: "/api/identity", headers, payload: { displayName: "Rate Four" } });
  assert.equal(limited.statusCode, 429);
  assert.equal(limited.json().error.code, "RATE_LIMITED");
  assert.ok(Number(limited.headers["retry-after"]) > 0);
});

test("expected context blocks stale reads and does not log out a replacement session", async () => {
  const first = await identity("Context One");
  const denied = await app.inject({ method: "GET", url: "/api/workspaces", headers: { cookie: first.cookie } });
  assert.equal(denied.statusCode, 409);
  assert.equal(denied.json().error.code, "SESSION_CONTEXT_CHANGED");

  const mismatch = await app.inject({
    method: "DELETE",
    url: "/api/session",
    headers: { ...origin, ...context(first.session, first.cookie), "x-moapp-expected-session-id": randomUUID() }
  });
  assert.equal(mismatch.statusCode, 409);
  assert.equal(mismatch.headers["set-cookie"], undefined);
  const row = app.db.prepare("SELECT revoked_at FROM sessions WHERE id=?").get(first.session.currentSessionId) as { revoked_at: string | null };
  assert.equal(row.revoked_at, null);
});

test("workspace creation is idempotent and owner mutations use versions", async () => {
  const owner = await identity("Owner");
  const headers = { ...origin, ...context(owner.session, owner.cookie) };
  const id = randomUUID();
  const created = await app.inject({ method: "POST", url: "/api/workspaces", headers, payload: { id, name: " Дом " } });
  assert.equal(created.statusCode, 201, created.body);
  assert.equal(created.json().workspace.role, "owner");
  assert.equal(app.db.prepare("SELECT count(*) FROM categories WHERE workspace_id=?").pluck().get(id), 7);

  const replay = await app.inject({ method: "POST", url: "/api/workspaces", headers, payload: { id, name: "Дом" } });
  assert.equal(replay.statusCode, 200);
  assert.equal(app.db.prepare("SELECT count(*) FROM workspaces WHERE id=?").pluck().get(id), 1);
  const conflict = await app.inject({ method: "POST", url: "/api/workspaces", headers, payload: { id, name: "Дача" } });
  assert.equal(conflict.statusCode, 409);
  assert.equal(conflict.json().error.code, "IDEMPOTENCY_CONFLICT");

  const renamed = await app.inject({ method: "PATCH", url: `/api/workspaces/${id}`, headers, payload: { name: "Наш дом", version: 1 } });
  assert.equal(renamed.statusCode, 200, renamed.body);
  assert.equal(renamed.json().workspace.version, 2);
  const stale = await app.inject({ method: "PATCH", url: `/api/workspaces/${id}`, headers, payload: { name: "Старое", version: 1 } });
  assert.equal(stale.statusCode, 409);
  assert.equal(stale.json().error.code, "VERSION_CONFLICT");
});

test("route rate limits use the canonical error envelope", async () => {
  const owner = await identity("Workspace Rate Owner");
  const headers = { ...origin, ...context(owner.session, owner.cookie) };
  for (let index = 0; index < 5; index += 1) {
    const created = await app.inject({
      method: "POST",
      url: "/api/workspaces",
      headers,
      payload: { id: randomUUID(), name: `Rate workspace ${index + 1}` }
    });
    assert.equal(created.statusCode, 201, `workspace ${index + 1}: ${created.body}`);
  }
  const limited = await app.inject({
    method: "POST",
    url: "/api/workspaces",
    headers,
    payload: { id: randomUUID(), name: "Rate workspace 6" }
  });
  assert.equal(limited.statusCode, 429, limited.body);
  assert.equal(limited.json().error.code, "RATE_LIMITED");
  assert.ok(Number(limited.headers["retry-after"]) > 0);
});

test("membership removal, leave and ownership transfer stay workspace scoped", async () => {
  const owner = await identity("Workspace Owner");
  const member = await identity("Workspace Member");
  const workspaceA = randomUUID();
  const workspaceB = randomUUID();
  const now = new Date().toISOString();
  app.db.transaction(() => {
    for (const id of [workspaceA, workspaceB]) {
      app.db.prepare("INSERT INTO workspaces(id,name,owner_user_id,version,created_at,updated_at) VALUES (?,?,?,1,?,?)")
        .run(id, id === workspaceA ? "A" : "B", owner.session.user.id, now, now);
      app.db.prepare("INSERT INTO memberships(workspace_id,user_id,joined_at,added_by_user_id) VALUES (?,?,?,NULL)")
        .run(id, owner.session.user.id, now);
      app.db.prepare("INSERT INTO memberships(workspace_id,user_id,joined_at,added_by_user_id) VALUES (?,?,?,?)")
        .run(id, member.session.user.id, now, owner.session.user.id);
      seedWorkspaceCategories(app.db, id);
    }
  })();
  const memberHeaders = { ...origin, ...context(member.session, member.cookie) };
  const forbidden = await app.inject({ method: "PATCH", url: `/api/workspaces/${workspaceA}`, headers: memberHeaders, payload: { name: "No", version: 1 } });
  assert.equal(forbidden.statusCode, 403);

  const ownerHeaders = { ...origin, ...context(owner.session, owner.cookie) };
  const transfer = await app.inject({ method: "POST", url: `/api/workspaces/${workspaceA}/transfer-ownership`, headers: ownerHeaders, payload: { userId: member.session.user.id, version: 1 } });
  assert.equal(transfer.statusCode, 200, transfer.body);
  assert.equal(transfer.json().workspace.role, "member");
  const oldOwnerLeaves = await app.inject({ method: "DELETE", url: `/api/workspaces/${workspaceA}/members/me`, headers: ownerHeaders });
  assert.equal(oldOwnerLeaves.statusCode, 204, oldOwnerLeaves.body);
  assert.ok(app.db.prepare("SELECT 1 FROM memberships WHERE workspace_id=? AND user_id=?").get(workspaceB, owner.session.user.id));

  const newOwnerCannotLeave = await app.inject({ method: "DELETE", url: `/api/workspaces/${workspaceA}/members/me`, headers: memberHeaders });
  assert.equal(newOwnerCannotLeave.statusCode, 409);
  assert.equal(newOwnerCannotLeave.json().error.code, "OWNER_CANNOT_LEAVE");
});

test("session list is user scoped and revocation closes related capabilities", async () => {
  const identityOne = await identity("Devices");
  const extra = createSession(app.db, config, { userId: identityOne.session.user.id, userAgent: "Firefox/120 Linux" });
  const headers = { ...origin, ...context(identityOne.session, identityOne.cookie) };
  const listed = await app.inject({ method: "GET", url: "/api/me/sessions", headers });
  assert.equal(listed.statusCode, 200);
  assert.equal(listed.json().sessions.length, 2);
  assert.equal(listed.json().sessions.filter((row: { current: boolean }) => row.current).length, 1);
  const workspaceId = randomUUID();
  const now = new Date().toISOString();
  const expiry = new Date(Date.now() + 60_000).toISOString();
  app.db.transaction(() => {
    app.db.prepare("INSERT INTO workspaces(id,name,owner_user_id,version,created_at,updated_at) VALUES (?,?,?,1,?,?)")
      .run(workspaceId, "Links", identityOne.session.user.id, now, now);
    app.db.prepare("INSERT INTO memberships(workspace_id,user_id,joined_at,added_by_user_id) VALUES (?,?,?,NULL)")
      .run(workspaceId, identityOne.session.user.id, now);
    app.db.prepare(`INSERT INTO access_tokens(id,kind,token_hash,workspace_id,target_user_id,created_by_user_id,created_by_session_id,replacement_token_hash,expected_generation,revoke_sessions,accept_attempt_hash,accepted_session_id,created_at,expires_at,consumed_at,revoked_at)
      VALUES (?,'invitation',?,?,NULL,?,?,NULL,NULL,0,NULL,NULL,?,?,NULL,NULL)`)
      .run(randomUUID(), randomBytes(32).toString("hex"), workspaceId, identityOne.session.user.id, extra.id, now, expiry);
  })();
  const revoked = await app.inject({ method: "DELETE", url: `/api/me/sessions/${extra.id}`, headers });
  assert.equal(revoked.statusCode, 204);
  assert.ok(app.db.prepare("SELECT 1 FROM access_tokens WHERE created_by_session_id=? AND revoked_at IS NOT NULL").get(extra.id));

  const other = await identity("Other Devices");
  const foreign = await app.inject({ method: "DELETE", url: `/api/me/sessions/${other.session.currentSessionId}`, headers });
  assert.equal(foreign.statusCode, 404);
});

test("normal sessions slide only after the refresh interval", async () => {
  const normal = await identity("Sliding");
  const staleLastSeen = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
  const oldExpiry = new Date(Date.now() + 60_000).toISOString();
  app.db.prepare("UPDATE sessions SET last_seen_at=?,expires_at=? WHERE id=?").run(staleLastSeen, oldExpiry, normal.session.currentSessionId);
  const probe = await app.inject({ method: "GET", url: "/api/session", headers: { cookie: normal.cookie } });
  assert.equal(probe.statusCode, 200);
  assert.ok(probe.json().currentSessionExpiresAt > oldExpiry);
  assert.equal(typeof probe.headers["set-cookie"], "string");
  const extended = probe.json().currentSessionExpiresAt;
  const nextCookie = cookieFrom(probe);
  const secondProbe = await app.inject({ method: "GET", url: "/api/session", headers: { cookie: nextCookie } });
  assert.equal(secondProbe.json().currentSessionExpiresAt, extended);
  assert.equal(secondProbe.headers["set-cookie"], undefined);
});

test("legacy claim creates a hard-expiry restricted session and supports only matching retry", async () => {
  const legacyUserId = randomUUID();
  const legacyWorkspaceId = randomUUID();
  const now = new Date().toISOString();
  app.db.transaction(() => {
    app.db.prepare("INSERT INTO users(id,display_name,recovery_token_hash,recovery_generation,created_at,updated_at) VALUES (?,?,NULL,0,?,?)")
      .run(legacyUserId, "Legacy", now, now);
    app.db.prepare("INSERT INTO workspaces(id,name,owner_user_id,version,created_at,updated_at) VALUES (?,?,?,1,?,?)")
      .run(legacyWorkspaceId, "Основное", legacyUserId, now, now);
    app.db.prepare("INSERT INTO memberships(workspace_id,user_id,joined_at,added_by_user_id) VALUES (?,?,?,NULL)")
      .run(legacyWorkspaceId, legacyUserId, now);
    app.db.prepare("INSERT INTO legacy_claims(workspace_id,owner_user_id,state,attempt_hash,pending_session_id,pending_expires_at,updated_at) VALUES (?,?,'open',NULL,NULL,NULL,?)")
      .run(legacyWorkspaceId, legacyUserId, now);
  })();
  const attemptToken = randomBytes(32).toString("base64url");
  const normal = await identity("Already signed in");
  const normalConflict = await app.inject({
    method: "POST",
    url: "/api/legacy-claim",
    headers: { ...origin, ...context(normal.session, normal.cookie) },
    payload: { pin: config.pin, displayName: "Legacy Owner", attemptToken }
  });
  assert.equal(normalConflict.statusCode, 409);
  assert.equal(normalConflict.json().error.code, "ALREADY_AUTHENTICATED");
  const claim = await app.inject({ method: "POST", url: "/api/legacy-claim", headers: origin, payload: { pin: config.pin, displayName: "Legacy Owner", attemptToken } });
  assert.equal(claim.statusCode, 200, claim.body);
  assert.equal(claim.json().restrictedToRecovery, true);
  assert.deepEqual(claim.json().workspaces, []);
  const claimCookie = cookieFrom(claim);
  const claimHeaders = { ...origin, ...context(claim.json(), claimCookie) };
  const blocked = await app.inject({ method: "GET", url: "/api/workspaces", headers: claimHeaders });
  assert.equal(blocked.statusCode, 401);
  const retry = await app.inject({ method: "POST", url: "/api/legacy-claim", headers: claimHeaders, payload: { pin: config.pin, displayName: "Legacy Owner", attemptToken } });
  assert.equal(retry.statusCode, 200);
  assert.equal(retry.json().currentSessionId, claim.json().currentSessionId);
  const restrictedMismatch = await app.inject({ method: "POST", url: "/api/legacy-claim", headers: claimHeaders, payload: { pin: config.pin, displayName: "Legacy Owner", attemptToken: randomBytes(32).toString("base64url") } });
  assert.equal(restrictedMismatch.statusCode, 409);
  assert.equal(restrictedMismatch.json().error.code, "CLAIM_IN_PROGRESS");
  const restrictedRow = app.db.prepare("SELECT revoked_at FROM sessions WHERE id=?").get(claim.json().currentSessionId) as { revoked_at: string | null };
  assert.equal(restrictedRow.revoked_at, null);
  assert.equal(restrictedMismatch.headers["set-cookie"], undefined);
  const competing = await app.inject({ method: "POST", url: "/api/legacy-claim", headers: origin, payload: { pin: config.pin, displayName: "Other", attemptToken: randomBytes(32).toString("base64url") } });
  assert.equal(competing.statusCode, 409);
  assert.equal(competing.json().error.code, "CLAIM_IN_PROGRESS");
  app.db.prepare("UPDATE legacy_claims SET pending_expires_at=? WHERE workspace_id=?").run(new Date(Date.now() - 1).toISOString(), legacyWorkspaceId);
  const expiredProbe = await app.inject({ method: "GET", url: "/api/session", headers: { cookie: claimCookie } });
  assert.equal(expiredProbe.statusCode, 200);
  assert.equal(expiredProbe.json().authenticated, false);
  const expiredRow = app.db.prepare("SELECT revoked_at FROM sessions WHERE id=?").get(claim.json().currentSessionId) as { revoked_at: string | null };
  assert.notEqual(expiredRow.revoked_at, null);
});
