import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { test } from "node:test";
import type { FastifyInstance } from "fastify";
import { createSession, hashSecret } from "../src/auth.js";
import { registerAccessRoutes } from "../src/access/index.js";
import { cleanupExpiredAccessRows, LINK_INVALID_MESSAGE } from "../src/access/token-helpers.js";
import { buildTestApp, testConfig } from "./test-app.js";

const config = testConfig();
const origin = { origin: config.appOrigin };

type Identity = { session: any; cookie: string };

function cookieFrom(response: { headers: Record<string, string | string[] | undefined> }): string {
  const value = response.headers["set-cookie"];
  assert.equal(typeof value, "string");
  return value.split(";", 1)[0]!;
}

function context(identity: Identity) {
  return {
    cookie: identity.cookie,
    "x-moapp-expected-user-id": identity.session.user.id as string,
    "x-moapp-expected-session-id": identity.session.currentSessionId as string
  };
}

function tokenFrom(url: string): string {
  const token = url.split("/").at(-1);
  assert.match(token ?? "", /^[A-Za-z0-9_-]{43}$/);
  return token!;
}

function accessError(response: { statusCode: number; json(): any }): void {
  assert.equal(response.statusCode, 410);
  assert.deepEqual(response.json(), { error: { code: "LINK_INVALID", message: LINK_INVALID_MESSAGE } });
}

async function identity(app: FastifyInstance, name: string, ip = `192.0.2.${Math.floor(Math.random() * 200) + 1}`): Promise<Identity> {
  const response = await app.inject({ method: "POST", url: "/api/identity", headers: { ...origin, "x-forwarded-for": ip }, payload: { displayName: name } });
  assert.equal(response.statusCode, 201, response.body);
  return { session: response.json(), cookie: cookieFrom(response) };
}

async function workspace(app: FastifyInstance, owner: Identity, name = "Дом"): Promise<string> {
  const id = randomUUID();
  const response = await app.inject({ method: "POST", url: "/api/workspaces", headers: { ...origin, ...context(owner) }, payload: { id, name } });
  assert.equal(response.statusCode, 201, response.body);
  return id;
}

async function invitation(app: FastifyInstance, owner: Identity, workspaceId: string) {
  return app.inject({
    method: "POST",
    url: `/api/workspaces/${workspaceId}/invitations`,
    headers: { ...origin, host: "attacker.example", ...context(owner) },
    payload: {}
  });
}

async function setupRecovery(app: FastifyInstance, identityValue: Identity): Promise<string> {
  const prepared = await app.inject({
    method: "POST", url: "/api/me/recovery/rotation/prepare",
    headers: { ...origin, ...context(identityValue) }, payload: {}
  });
  assert.equal(prepared.statusCode, 200, prepared.body);
  const complete = await app.inject({
    method: "POST", url: "/api/me/recovery/rotation/complete",
    headers: { ...origin, ...context(identityValue) }, payload: { completionToken: prepared.json().completionToken }
  });
  assert.equal(complete.statusCode, 200, complete.body);
  identityValue.session = complete.json();
  return tokenFrom(prepared.json().recoveryUrl);
}

test("invitations are owner-only, hash-only, one-use capabilities with purpose isolation", async () => {
  const app = await buildTestApp({ config, plugins: [registerAccessRoutes] });
  try {
    const owner = await identity(app, "Owner", "192.0.2.10");
    const firstMember = await identity(app, "First member", "192.0.2.11");
    const secondMember = await identity(app, "Second member", "192.0.2.12");
    const workspaceId = await workspace(app, owner);

    const created = await invitation(app, owner, workspaceId);
    assert.equal(created.statusCode, 201, created.body);
    assert.equal(created.headers["cache-control"], "private, no-store");
    assert.match(created.json().url, new RegExp(`^${config.appOrigin}/#/join/`));
    assert.doesNotMatch(created.json().url, /attacker/);
    const token = tokenFrom(created.json().url);
    const stored = app.db.prepare("SELECT token_hash FROM access_tokens WHERE id=?").get(created.json().invitation.id) as { token_hash: string };
    assert.equal(stored.token_hash, hashSecret(token));
    assert.notEqual(stored.token_hash, token);

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const preview = await app.inject({ method: "POST", url: "/api/access/invitations/preview", headers: origin, payload: { token } });
      assert.equal(preview.statusCode, 200, preview.body);
      assert.equal(preview.json().workspace.id, workspaceId);
      assert.equal(preview.headers["cache-control"], "private, no-store");
    }
    const wrongPurpose = await app.inject({ method: "POST", url: "/api/access/device-links/preview", headers: origin, payload: { token } });
    accessError(wrongPurpose);

    const accepted = await app.inject({
      method: "POST", url: "/api/access/invitations/accept",
      headers: { ...origin, ...context(firstMember) }, payload: { token }
    });
    assert.equal(accepted.statusCode, 200, accepted.body);
    assert.equal(accepted.json().workspace.role, "member");
    accessError(await app.inject({
      method: "POST", url: "/api/access/invitations/accept",
      headers: { ...origin, ...context(secondMember) }, payload: { token }
    }));

    const stillUsable = await invitation(app, owner, workspaceId);
    const secondToken = tokenFrom(stillUsable.json().url);
    const alreadyMember = await app.inject({
      method: "POST", url: "/api/access/invitations/accept",
      headers: { ...origin, ...context(firstMember) }, payload: { token: secondToken }
    });
    assert.equal(alreadyMember.statusCode, 409);
    assert.equal(alreadyMember.json().error.code, "ALREADY_MEMBER");
    const secondAccept = await app.inject({
      method: "POST", url: "/api/access/invitations/accept",
      headers: { ...origin, ...context(secondMember) }, payload: { token: secondToken }
    });
    assert.equal(secondAccept.statusCode, 200, secondAccept.body);

    const forbidden = await app.inject({
      method: "POST", url: `/api/workspaces/${workspaceId}/invitations`,
      headers: { ...origin, ...context(firstMember) }, payload: {}
    });
    assert.equal(forbidden.statusCode, 403);
    assert.equal(forbidden.json().error.code, "FORBIDDEN");

    const listed = await app.inject({ method: "GET", url: `/api/workspaces/${workspaceId}/invitations`, headers: context(owner) });
    assert.equal(listed.statusCode, 200);
    assert.doesNotMatch(listed.body, new RegExp(token));
    assert.doesNotMatch(JSON.stringify(app.db.prepare("SELECT * FROM access_tokens").all()), new RegExp(token));
  } finally {
    await app.close();
  }
});

test("invitation revoke, expiry, use and creator logout have the same public failure", async () => {
  const app = await buildTestApp({ config, plugins: [registerAccessRoutes] });
  try {
    const owner = await identity(app, "Owner", "192.0.2.20");
    const workspaceId = await workspace(app, owner);
    const made = await invitation(app, owner, workspaceId);
    const token = tokenFrom(made.json().url);
    const revoked = await app.inject({
      method: "DELETE", url: `/api/workspaces/${workspaceId}/invitations/${made.json().invitation.id}`,
      headers: { ...origin, ...context(owner) }
    });
    assert.equal(revoked.statusCode, 204, revoked.body);
    accessError(await app.inject({ method: "POST", url: "/api/access/invitations/preview", headers: origin, payload: { token } }));

    const expired = await invitation(app, owner, workspaceId);
    const expiredToken = tokenFrom(expired.json().url);
    app.db.prepare("UPDATE access_tokens SET expires_at=? WHERE id=?").run(new Date(Date.now() - 1).toISOString(), expired.json().invitation.id);
    accessError(await app.inject({ method: "POST", url: "/api/access/invitations/preview", headers: origin, payload: { token: expiredToken } }));

    const logoutLink = await invitation(app, owner, workspaceId);
    const logoutToken = tokenFrom(logoutLink.json().url);
    const logout = await app.inject({ method: "DELETE", url: "/api/session", headers: { ...origin, ...context(owner) } });
    assert.equal(logout.statusCode, 204);
    accessError(await app.inject({ method: "POST", url: "/api/access/invitations/preview", headers: origin, payload: { token: logoutToken } }));
  } finally {
    await app.close();
  }
});

test("device accept retries only the same attempt while its accepted session remains active", async () => {
  const app = await buildTestApp({ config, plugins: [registerAccessRoutes] });
  try {
    const owner = await identity(app, "Device owner", "192.0.2.30");
    const workspaceId = await workspace(app, owner);
    const link = await app.inject({ method: "POST", url: "/api/me/device-links", headers: { ...origin, ...context(owner) }, payload: {} });
    assert.equal(link.statusCode, 201, link.body);
    const token = tokenFrom(link.json().url);
    const preview = await app.inject({ method: "POST", url: "/api/access/device-links/preview", headers: origin, payload: { token } });
    assert.equal(preview.json().targetUserId, owner.session.user.id);
    const attemptToken = randomBytes(32).toString("base64url");
    const accepted = await app.inject({ method: "POST", url: "/api/access/device-links/accept", headers: origin, payload: { token, attemptToken } });
    assert.equal(accepted.statusCode, 200, accepted.body);
    assert.equal(accepted.json().user.id, owner.session.user.id);
    assert.equal(accepted.json().workspaces[0].id, workspaceId);
    const firstAcceptedSession = accepted.json().currentSessionId as string;
    const retry = await app.inject({ method: "POST", url: "/api/access/device-links/accept", headers: origin, payload: { token, attemptToken } });
    assert.equal(retry.statusCode, 200, retry.body);
    assert.notEqual(retry.json().currentSessionId, firstAcceptedSession);
    assert.ok(app.db.prepare("SELECT 1 FROM sessions WHERE id=? AND revoked_at IS NOT NULL").get(firstAcceptedSession));
    accessError(await app.inject({
      method: "POST", url: "/api/access/device-links/accept", headers: origin,
      payload: { token, attemptToken: randomBytes(32).toString("base64url") }
    }));

    const retryIdentity: Identity = { session: retry.json(), cookie: cookieFrom(retry) };
    const logout = await app.inject({ method: "DELETE", url: "/api/session", headers: { ...origin, ...context(retryIdentity) } });
    assert.equal(logout.statusCode, 204);
    accessError(await app.inject({ method: "POST", url: "/api/access/device-links/accept", headers: origin, payload: { token, attemptToken } }));
  } finally {
    await app.close();
  }
});

test("device links reject an existing identity without consuming the link", async () => {
  const app = await buildTestApp({ config, plugins: [registerAccessRoutes] });
  try {
    const owner = await identity(app, "Device owner", "192.0.2.40");
    const other = await identity(app, "Other profile", "192.0.2.41");
    const link = await app.inject({ method: "POST", url: "/api/me/device-links", headers: { ...origin, ...context(owner) }, payload: {} });
    const token = tokenFrom(link.json().url);
    const conflict = await app.inject({
      method: "POST", url: "/api/access/device-links/accept",
      headers: { ...origin, ...context(other) }, payload: { token, attemptToken: randomBytes(32).toString("base64url") }
    });
    assert.equal(conflict.statusCode, 409);
    assert.equal(conflict.json().error.code, "IDENTITY_CONFLICT");
    const row = app.db.prepare("SELECT consumed_at FROM access_tokens WHERE token_hash=?").get(hashSecret(token)) as { consumed_at: string | null };
    assert.equal(row.consumed_at, null);
    const sameProfile = await app.inject({
      method: "POST", url: "/api/access/device-links/accept",
      headers: { ...origin, ...context(owner) }, payload: { token, attemptToken: randomBytes(32).toString("base64url") }
    });
    assert.equal(sameProfile.statusCode, 409);
    assert.equal(sameProfile.json().error.code, "ALREADY_CONNECTED");
    assert.equal((app.db.prepare("SELECT consumed_at FROM access_tokens WHERE token_hash=?").get(hashSecret(token)) as any).consumed_at, null);
  } finally {
    await app.close();
  }
});

test("guest-capable mutations require the hydrated cookie context", async () => {
  const app = await buildTestApp({ config, plugins: [registerAccessRoutes] });
  try {
    const owner = await identity(app, "Context owner", "192.0.2.42");
    const link = await app.inject({
      method: "POST", url: "/api/me/device-links",
      headers: { ...origin, ...context(owner) }, payload: {}
    });
    const token = tokenFrom(link.json().url);
    const attemptToken = randomBytes(32).toString("base64url");
    const missing = await app.inject({
      method: "POST", url: "/api/access/device-links/accept",
      headers: { ...origin, cookie: owner.cookie }, payload: { token, attemptToken }
    });
    assert.equal(missing.statusCode, 409);
    assert.equal(missing.json().error.code, "SESSION_CONTEXT_CHANGED");
    assert.equal((app.db.prepare("SELECT consumed_at FROM access_tokens WHERE token_hash=?")
      .get(hashSecret(token)) as { consumed_at: string | null }).consumed_at, null);
  } finally {
    await app.close();
  }
});

test("manual recovery is two-phase and concurrent rotations use generation CAS", async () => {
  const app = await buildTestApp({ config, plugins: [registerAccessRoutes] });
  try {
    const user = await identity(app, "Recovery owner", "192.0.2.50");
    const firstPrepare = await app.inject({
      method: "POST", url: "/api/me/recovery/rotation/prepare", headers: { ...origin, ...context(user) }, payload: {}
    });
    assert.equal(firstPrepare.statusCode, 200, firstPrepare.body);
    const firstRecovery = tokenFrom(firstPrepare.json().recoveryUrl);
    assert.equal((app.db.prepare("SELECT recovery_token_hash FROM users WHERE id=?").get(user.session.user.id) as any).recovery_token_hash, null);
    accessError(await app.inject({ method: "POST", url: "/api/access/recovery/preview", headers: origin, payload: { token: firstRecovery } }));
    const firstComplete = await app.inject({
      method: "POST", url: "/api/me/recovery/rotation/complete", headers: { ...origin, ...context(user) },
      payload: { completionToken: firstPrepare.json().completionToken }
    });
    assert.equal(firstComplete.statusCode, 200, firstComplete.body);
    user.session = firstComplete.json();
    assert.equal(user.session.user.recoveryGeneration, 1);
    assert.equal((app.db.prepare("SELECT revoked_at FROM sessions WHERE id=?").get(user.session.currentSessionId) as any).revoked_at, null);

    const prepareA = await app.inject({ method: "POST", url: "/api/me/recovery/rotation/prepare", headers: { ...origin, ...context(user) }, payload: {} });
    const prepareB = await app.inject({ method: "POST", url: "/api/me/recovery/rotation/prepare", headers: { ...origin, ...context(user) }, payload: {} });
    assert.equal(prepareA.json().nextGeneration, 2);
    assert.equal(prepareB.json().nextGeneration, 2);
    const recoveryA = tokenFrom(prepareA.json().recoveryUrl);
    const recoveryB = tokenFrom(prepareB.json().recoveryUrl);
    const oldStillActive = await app.inject({ method: "POST", url: "/api/access/recovery/preview", headers: origin, payload: { token: firstRecovery } });
    assert.equal(oldStillActive.statusCode, 200);

    const completeA = await app.inject({
      method: "POST", url: "/api/me/recovery/rotation/complete", headers: { ...origin, ...context(user) },
      payload: { completionToken: prepareA.json().completionToken }
    });
    assert.equal(completeA.statusCode, 200, completeA.body);
    user.session = completeA.json();
    const staleB = await app.inject({
      method: "POST", url: "/api/me/recovery/rotation/complete", headers: { ...origin, ...context(user) },
      payload: { completionToken: prepareB.json().completionToken }
    });
    assert.equal(staleB.statusCode, 409);
    assert.equal(staleB.json().error.code, "ROTATION_STALE");
    assert.equal((await app.inject({ method: "POST", url: "/api/access/recovery/preview", headers: origin, payload: { token: recoveryA } })).statusCode, 200);
    accessError(await app.inject({ method: "POST", url: "/api/access/recovery/preview", headers: origin, payload: { token: recoveryB } }));
    accessError(await app.inject({ method: "POST", url: "/api/access/recovery/preview", headers: origin, payload: { token: firstRecovery } }));
  } finally {
    await app.close();
  }
});

test("public recovery preserves old access until complete, then revokes all old access and creates one session", async () => {
  const app = await buildTestApp({ config, plugins: [registerAccessRoutes] });
  try {
    const user = await identity(app, "Recover me", "192.0.2.60");
    const recoveryToken = await setupRecovery(app, user);
    const workspaceId = await workspace(app, user, "Recovery workspace");
    const extra = createSession(app.db, config, { userId: user.session.user.id });
    const device = await app.inject({ method: "POST", url: "/api/me/device-links", headers: { ...origin, ...context(user) }, payload: {} });
    const invite = await invitation(app, user, workspaceId);

    const prepared = await app.inject({ method: "POST", url: "/api/access/recovery/prepare", headers: origin, payload: { token: recoveryToken } });
    assert.equal(prepared.statusCode, 200, prepared.body);
    const replacement = tokenFrom(prepared.json().recoveryUrl);
    assert.equal((await app.inject({ method: "POST", url: "/api/access/recovery/preview", headers: origin, payload: { token: recoveryToken } })).statusCode, 200);
    assert.equal((app.db.prepare("SELECT revoked_at FROM sessions WHERE id=?").get(extra.id) as any).revoked_at, null);

    const other = await identity(app, "Wrong browser", "192.0.2.61");
    const conflict = await app.inject({
      method: "POST", url: "/api/access/recovery/complete", headers: { ...origin, ...context(other) },
      payload: { completionToken: prepared.json().completionToken }
    });
    assert.equal(conflict.statusCode, 409);
    assert.equal(conflict.json().error.code, "IDENTITY_CONFLICT");

    const completed = await app.inject({ method: "POST", url: "/api/access/recovery/complete", headers: origin, payload: { completionToken: prepared.json().completionToken } });
    assert.equal(completed.statusCode, 200, completed.body);
    assert.equal(completed.headers["cache-control"], "private, no-store");
    assert.equal(completed.json().user.id, user.session.user.id);
    const active = app.db.prepare("SELECT id FROM sessions WHERE user_id=? AND revoked_at IS NULL AND expires_at>?").all(user.session.user.id, new Date().toISOString()) as Array<{ id: string }>;
    assert.deepEqual(active.map((row) => row.id), [completed.json().currentSessionId]);
    assert.ok(app.db.prepare("SELECT 1 FROM access_tokens WHERE id=? AND revoked_at IS NOT NULL").get(device.json().deviceLink.id));
    assert.ok(app.db.prepare("SELECT 1 FROM access_tokens WHERE id=? AND revoked_at IS NOT NULL").get(invite.json().invitation.id));
    accessError(await app.inject({ method: "POST", url: "/api/access/recovery/preview", headers: origin, payload: { token: recoveryToken } }));
    assert.equal((await app.inject({ method: "POST", url: "/api/access/recovery/preview", headers: origin, payload: { token: replacement } })).statusCode, 200);
    accessError(await app.inject({ method: "POST", url: "/api/access/recovery/complete", headers: origin, payload: { completionToken: prepared.json().completionToken } }));
  } finally {
    await app.close();
  }
});

test("restricted legacy recovery closes the claim atomically and never activates after lease expiry", async () => {
  const app = await buildTestApp({ config, plugins: [registerAccessRoutes] });
  try {
    const userId = randomUUID();
    const workspaceId = randomUUID();
    const now = new Date().toISOString();
    app.db.transaction(() => {
      app.db.prepare("INSERT INTO users(id,display_name,recovery_token_hash,recovery_generation,created_at,updated_at) VALUES (?,?,NULL,0,?,?)").run(userId, "Legacy", now, now);
      app.db.prepare("INSERT INTO workspaces(id,name,owner_user_id,version,created_at,updated_at) VALUES (?,?,?,1,?,?)").run(workspaceId, "Legacy", userId, now, now);
      app.db.prepare("INSERT INTO memberships(workspace_id,user_id,joined_at,added_by_user_id) VALUES (?,?,?,NULL)").run(workspaceId, userId, now);
      app.db.prepare("INSERT INTO legacy_claims(workspace_id,owner_user_id,state,attempt_hash,pending_session_id,pending_expires_at,updated_at) VALUES (?,?,'open',NULL,NULL,NULL,?)").run(workspaceId, userId, now);
    })();
    const claimAttempt = randomBytes(32).toString("base64url");
    const claim = await app.inject({ method: "POST", url: "/api/legacy-claim", headers: origin, payload: { pin: config.pin, displayName: "Legacy", attemptToken: claimAttempt } });
    assert.equal(claim.statusCode, 200, claim.body);
    const restricted: Identity = { session: claim.json(), cookie: cookieFrom(claim) };
    const restrictedPreview = await app.inject({
      method: "POST", url: "/api/access/recovery/preview",
      headers: { ...origin, ...context(restricted) },
      payload: { token: randomBytes(32).toString("base64url") }
    });
    assert.equal(restrictedPreview.statusCode, 401);
    const expiredPrepare = await app.inject({ method: "POST", url: "/api/me/recovery/rotation/prepare", headers: { ...origin, ...context(restricted) }, payload: {} });
    assert.equal(expiredPrepare.statusCode, 200, expiredPrepare.body);
    app.db.prepare("UPDATE legacy_claims SET pending_expires_at=? WHERE workspace_id=?").run(new Date(Date.now() - 1).toISOString(), workspaceId);
    const expiredComplete = await app.inject({
      method: "POST", url: "/api/me/recovery/rotation/complete", headers: { ...origin, ...context(restricted) },
      payload: { completionToken: expiredPrepare.json().completionToken }
    });
    assert.equal(expiredComplete.statusCode, 401, expiredComplete.body);
    assert.equal((app.db.prepare("SELECT recovery_token_hash FROM users WHERE id=?").get(userId) as any).recovery_token_hash, null);

    app.db.prepare("UPDATE legacy_claims SET state='open',attempt_hash=NULL,pending_session_id=NULL,pending_expires_at=NULL,updated_at=? WHERE workspace_id=?").run(new Date().toISOString(), workspaceId);
    const secondClaim = await app.inject({ method: "POST", url: "/api/legacy-claim", headers: origin, payload: {
      pin: config.pin, displayName: "Legacy", attemptToken: randomBytes(32).toString("base64url")
    } });
    assert.equal(secondClaim.statusCode, 200, secondClaim.body);
    const current: Identity = { session: secondClaim.json(), cookie: cookieFrom(secondClaim) };
    const prepared = await app.inject({ method: "POST", url: "/api/me/recovery/rotation/prepare", headers: { ...origin, ...context(current) }, payload: {} });
    const recoveryToken = tokenFrom(prepared.json().recoveryUrl);
    const completed = await app.inject({
      method: "POST", url: "/api/me/recovery/rotation/complete", headers: { ...origin, ...context(current) },
      payload: { completionToken: prepared.json().completionToken }
    });
    assert.equal(completed.statusCode, 200, completed.body);
    assert.equal(completed.json().restrictedToRecovery, false);
    assert.equal((app.db.prepare("SELECT state FROM legacy_claims WHERE workspace_id=?").get(workspaceId) as any).state, "closed");
    assert.ok(app.db.prepare("SELECT 1 FROM sessions WHERE id=? AND revoked_at IS NOT NULL").get(current.session.currentSessionId));
    assert.equal((await app.inject({ method: "POST", url: "/api/access/recovery/preview", headers: origin, payload: { token: recoveryToken } })).statusCode, 200);
  } finally {
    await app.close();
  }
});

test("access hardening enforces exact origin/JSON, rate limits, and ordered housekeeping", async () => {
  const limitedConfig = testConfig({
    access: { ...config.access, accessPreviewRateLimitPerMinute: 1 }
  });
  const app = await buildTestApp({ config: limitedConfig, plugins: [registerAccessRoutes] });
  try {
    const invalidToken = randomBytes(32).toString("base64url");
    const noOrigin = await app.inject({ method: "POST", url: "/api/access/invitations/preview", payload: { token: invalidToken } });
    assert.equal(noOrigin.statusCode, 403);
    const wrongType = await app.inject({
      method: "POST", url: "/api/access/invitations/preview",
      headers: { origin: limitedConfig.appOrigin, "content-type": "text/plain" }, payload: JSON.stringify({ token: invalidToken })
    });
    assert.equal(wrongType.statusCode, 415);
    accessError(await app.inject({ method: "POST", url: "/api/access/invitations/preview", headers: { origin: limitedConfig.appOrigin }, payload: { token: invalidToken } }));
    const limited = await app.inject({ method: "POST", url: "/api/access/invitations/preview", headers: { origin: limitedConfig.appOrigin }, payload: { token: invalidToken } });
    assert.equal(limited.statusCode, 429);
    assert.equal(typeof limited.headers["retry-after"], "string");

    const user = await identity(app, "Cleanup", "192.0.2.80");
    const session = createSession(app.db, limitedConfig, { userId: user.session.user.id, expiresAt: new Date(Date.now() - 1) });
    const past = new Date(Date.now() - 1).toISOString();
    app.db.prepare(`INSERT INTO access_tokens
      (id,kind,token_hash,workspace_id,target_user_id,created_by_user_id,created_by_session_id,replacement_token_hash,expected_generation,revoke_sessions,accept_attempt_hash,accepted_session_id,created_at,expires_at,consumed_at,revoked_at)
      VALUES (?,'device_link',?,NULL,?,?,?,NULL,NULL,0,NULL,NULL,?,?,NULL,NULL)`)
      .run(randomUUID(), hashSecret(randomBytes(32).toString("base64url")), user.session.user.id, user.session.user.id, session.id, past, past);
    const cleaned = cleanupExpiredAccessRows(app.db);
    assert.equal(cleaned.accessRows, 1);
    assert.equal(cleaned.sessions, 1);
  } finally {
    await app.close();
  }
});
