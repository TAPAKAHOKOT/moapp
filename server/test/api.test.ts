import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { buildApp } from "../src/app.js";
import { testConfig } from "./test-app.js";

const config = testConfig({ appOrigin: "https://moapp.test", secureCookies: false });
const app = await buildApp(config, { logger: false, scheduler: false });
const origin = { origin: config.appOrigin };

type Identity = {
  session: {
    user: { id: string };
    currentSessionId: string;
  };
  cookie: string;
};

let owner: Identity;
let workspaceId: string;

before(async () => app.ready());
after(async () => app.close());

function cookieFrom(response: { headers: Record<string, string | string[] | undefined> }): string {
  const value = response.headers["set-cookie"];
  assert.equal(typeof value, "string");
  return value.split(";", 1)[0]!;
}

function expectedContext(identity: Identity) {
  return {
    cookie: identity.cookie,
    "x-moapp-expected-user-id": identity.session.user.id,
    "x-moapp-expected-session-id": identity.session.currentSessionId
  };
}

async function createIdentity(displayName: string, forwardedFor: string): Promise<Identity> {
  const response = await app.inject({
    method: "POST",
    url: "/api/identity",
    headers: { ...origin, "x-forwarded-for": forwardedFor },
    payload: { displayName }
  });
  assert.equal(response.statusCode, 201, response.body);
  return { session: response.json(), cookie: cookieFrom(response) };
}

function assertSecurityHeaders(headers: Record<string, string | string[] | undefined>): void {
  assert.equal(headers["referrer-policy"], "no-referrer");
  assert.equal(headers["x-content-type-options"], "nosniff");
  assert.match(String(headers["content-security-policy"]), /frame-ancestors 'none'/);
  assert.equal(headers["strict-transport-security"], "max-age=31536000; includeSubDomains");
}

test("production health is public and all responses carry security headers", async () => {
  const health = await app.inject({ method: "GET", url: "/api/health" });
  assert.equal(health.statusCode, 200, health.body);
  assert.equal(health.json().status, "ok");
  assert.equal(health.headers["cache-control"], undefined);
  assertSecurityHeaders(health.headers);

  const heartbeat = app.db.prepare("SELECT value FROM app_meta WHERE key='backup_heartbeat'").get() as { value: string };
  assert.ok(!Number.isNaN(Date.parse(heartbeat.value)));
});

test("guest session and identity-to-scoped-workspace flow are wired in buildApp", async () => {
  const guest = await app.inject({ method: "GET", url: "/api/session" });
  assert.equal(guest.statusCode, 200, guest.body);
  assert.equal(guest.json().authenticated, false);
  assert.deepEqual(guest.json().workspaces, []);
  assert.equal(guest.headers["cache-control"], "private, no-store");

  owner = await createIdentity("Production Owner", "192.0.2.10");
  workspaceId = randomUUID();
  const created = await app.inject({
    method: "POST",
    url: "/api/workspaces",
    headers: { ...origin, ...expectedContext(owner) },
    payload: { id: workspaceId, name: "Дом" }
  });
  assert.equal(created.statusCode, 201, created.body);
  assert.equal(created.json().workspace.role, "owner");
  assert.equal(created.headers["cache-control"], "private, no-store");

  const bootstrap = await app.inject({
    method: "GET",
    url: `/api/workspaces/${workspaceId}/bootstrap`,
    headers: expectedContext(owner)
  });
  assert.equal(bootstrap.statusCode, 200, bootstrap.body);
  assert.equal(bootstrap.json().workspaceId, workspaceId);
  assert.equal(bootstrap.json().workspace.id, workspaceId);
  assert.equal(bootstrap.json().categories.length, 7);
  assert.deepEqual(bootstrap.json().expenses, []);
  assert.equal(bootstrap.headers["cache-control"], "private, no-store");
  assertSecurityHeaders(bootstrap.headers);
});

test("production build exposes access routes and canonical capability URLs", async () => {
  const invitation = await app.inject({
    method: "POST",
    url: `/api/workspaces/${workspaceId}/invitations`,
    headers: { ...origin, host: "attacker.example", ...expectedContext(owner) },
    payload: {}
  });
  assert.equal(invitation.statusCode, 201, invitation.body);
  assert.equal(invitation.headers["cache-control"], "private, no-store");
  assert.match(invitation.json().url, new RegExp(`^${config.appOrigin}/#/join/[A-Za-z0-9_-]{43}$`));
  assert.doesNotMatch(invitation.json().url, /attacker\.example/);

  const oauthMetadata = await app.inject({
    method: "GET",
    url: "/.well-known/oauth-protected-resource",
    headers: { host: "attacker.example" }
  });
  assert.equal(oauthMetadata.statusCode, 200, oauthMetadata.body);
  assert.equal(oauthMetadata.json().resource, `${config.appOrigin}/mcp`);
  assert.equal(oauthMetadata.headers["cache-control"], "no-store");
  const mcpChallenge = await app.inject({ method: "POST", url: "/mcp", headers: { host: "attacker.example" }, payload: {} });
  assert.equal(mcpChallenge.statusCode, 401, mcpChallenge.body);
  assert.match(String(mcpChallenge.headers["www-authenticate"]), new RegExp(`${config.appOrigin}/\\.well-known/oauth-protected-resource`));
});

test("foreign workspace access and stale expected context fail closed", async () => {
  const foreign = await createIdentity("Foreign User", "192.0.2.11");
  const foreignRead = await app.inject({
    method: "GET",
    url: `/api/workspaces/${workspaceId}/bootstrap`,
    headers: expectedContext(foreign)
  });
  assert.equal(foreignRead.statusCode, 404, foreignRead.body);
  assert.equal(foreignRead.json().error.code, "WORKSPACE_NOT_FOUND");

  const stale = await app.inject({
    method: "GET",
    url: `/api/workspaces/${workspaceId}/bootstrap`,
    headers: {
      ...expectedContext(owner),
      "x-moapp-expected-session-id": randomUUID()
    }
  });
  assert.equal(stale.statusCode, 409, stale.body);
  assert.equal(stale.json().error.code, "SESSION_CONTEXT_CHANGED");
  assert.equal(stale.headers["cache-control"], "private, no-store");
});

test("legacy PIN and unscoped API routes return upgrade-required", async () => {
  const requests = [
    app.inject({ method: "POST", url: "/api/session", headers: origin, payload: { pin: config.pin } }),
    app.inject({ method: "POST", url: "/api/auth/login", headers: origin, payload: { pin: config.pin } }),
    app.inject({ method: "GET", url: "/api/bootstrap" }),
    app.inject({ method: "GET", url: "/api/expenses" })
  ];
  for (const response of await Promise.all(requests)) {
    assert.equal(response.statusCode, 410, response.body);
    assert.equal(response.json().error.code, "UPGRADE_REQUIRED");
    assert.equal(response.headers["cache-control"], "private, no-store");
  }
});
