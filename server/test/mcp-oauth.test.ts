import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { afterEach, test } from "node:test";
import type { FastifyInstance } from "fastify";
import { hashSecret } from "../src/auth.js";
import { registerMcpRoutes } from "../src/mcp.js";
import { mcpResource, registerOAuthRoutes } from "../src/oauth.js";
import { buildTestApp } from "./test-app.js";

const apps: FastifyInstance[] = [];
afterEach(async () => Promise.all(apps.splice(0).map((app) => app.close())));

type Identity = {
  cookie: string;
  userId: string;
  sessionId: string;
  workspaceId: string;
};

async function createIdentity(app: FastifyInstance, name: string, workspaceName: string): Promise<Identity> {
  const identity = await app.inject({
    method: "POST",
    url: "/api/identity",
    headers: { origin: app.config.appOrigin, "content-type": "application/json", "user-agent": "MCP test" },
    payload: { displayName: name }
  });
  assert.equal(identity.statusCode, 201, identity.body);
  const session = identity.json() as { user: { id: string }; currentSessionId: string };
  const setCookie = identity.headers["set-cookie"];
  const cookieHeader = (Array.isArray(setCookie) ? setCookie[0] : setCookie)?.split(";", 1)[0];
  assert.ok(cookieHeader);
  const workspaceId = randomUUID();
  const workspace = await app.inject({
    method: "POST",
    url: "/api/workspaces",
    headers: {
      cookie: cookieHeader,
      origin: app.config.appOrigin,
      "content-type": "application/json",
      "x-moapp-expected-user-id": session.user.id,
      "x-moapp-expected-session-id": session.currentSessionId
    },
    payload: { id: workspaceId, name: workspaceName }
  });
  assert.equal(workspace.statusCode, 201, workspace.body);
  return { cookie: cookieHeader, userId: session.user.id, sessionId: session.currentSessionId, workspaceId };
}

async function registerClient(app: FastifyInstance, redirectUri = "https://chatgpt.com/connector/oauth/test") {
  const response = await app.inject({
    method: "POST",
    url: "/oauth/register",
    headers: { "content-type": "application/json" },
    payload: {
      client_name: "ChatGPT test",
      redirect_uris: [redirectUri],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"]
    }
  });
  assert.equal(response.statusCode, 201, response.body);
  return { clientId: (response.json() as { client_id: string }).client_id, redirectUri };
}

async function submitAuthorization(
  app: FastifyInstance,
  identity: Identity,
  client: { clientId: string; redirectUri: string },
  origin: string | null = app.config.appOrigin
) {
  const verifier = "mcp-test-verifier-that-is-long-enough-for-pkce-1234567890";
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const fields = new URLSearchParams({
    response_type: "code",
    client_id: client.clientId,
    redirect_uri: client.redirectUri,
    scope: "history:read",
    state: "state-1",
    code_challenge: challenge,
    code_challenge_method: "S256",
    resource: mcpResource(app)
  });
  const consent = await app.inject({ method: "GET", url: `/oauth/authorize?${fields}`, headers: { cookie: identity.cookie } });
  assert.equal(consent.statusCode, 200, consent.body);
  assert.match(consent.body, /Разрешить доступ к истории/);
  const csrfToken = /name="csrf_token" value="([A-Za-z0-9_.-]+)"/.exec(consent.body)?.[1];
  assert.ok(csrfToken);
  const approval = new URLSearchParams(fields);
  approval.set("decision", "approve");
  approval.set("csrf_token", csrfToken);
  const headers: Record<string, string> = {
    cookie: identity.cookie,
    "content-type": "application/x-www-form-urlencoded"
  };
  if (origin !== null) headers.origin = origin;
  const approved = await app.inject({
    method: "POST",
    url: "/oauth/authorize",
    headers,
    payload: approval.toString()
  });
  return { approved, verifier };
}

async function authorize(app: FastifyInstance, identity: Identity, client: { clientId: string; redirectUri: string }, origin?: string | null) {
  const { approved, verifier } = await submitAuthorization(app, identity, client, origin === undefined ? app.config.appOrigin : origin);
  assert.equal(approved.statusCode, 302, approved.body);
  const callback = new URL(approved.headers.location!);
  assert.equal(callback.searchParams.get("state"), "state-1");
  assert.equal(callback.searchParams.get("iss"), app.config.appOrigin);
  const code = callback.searchParams.get("code");
  assert.ok(code);
  return { code, verifier };
}

async function exchangeCode(app: FastifyInstance, client: { clientId: string; redirectUri: string }, code: string, verifier: string) {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: client.clientId,
    code,
    redirect_uri: client.redirectUri,
    code_verifier: verifier,
    resource: mcpResource(app)
  });
  return app.inject({
    method: "POST",
    url: "/oauth/token",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    payload: body.toString()
  });
}

async function mcpRequest(app: FastifyInstance, accessToken: string, id: number, method: string, params: Record<string, unknown>) {
  return app.inject({
    method: "POST",
    url: "/mcp",
    headers: {
      authorization: `Bearer ${accessToken}`,
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      "mcp-protocol-version": "2025-11-25"
    },
    payload: { jsonrpc: "2.0", id, method, params }
  });
}

test("OAuth discovery, DCR and PKCE issue only hashed, refreshable credentials", async () => {
  const app = await buildTestApp({ plugins: [registerOAuthRoutes, registerMcpRoutes] });
  apps.push(app);
  const metadata = await app.inject({ method: "GET", url: "/.well-known/oauth-authorization-server" });
  assert.equal(metadata.statusCode, 200);
  assert.deepEqual(metadata.json().code_challenge_methods_supported, ["S256"]);
  assert.deepEqual(metadata.json().token_endpoint_auth_methods_supported, ["none"]);
  const resource = await app.inject({ method: "GET", url: "/.well-known/oauth-protected-resource" });
  assert.equal(resource.json().resource, "http://moapp.test/mcp");

  const invalidClient = await app.inject({
    method: "POST",
    url: "/oauth/register",
    headers: { "content-type": "application/json" },
    payload: { redirect_uris: ["http://attacker.example/callback"] }
  });
  assert.equal(invalidClient.statusCode, 400);
  assert.equal(invalidClient.json().error, "invalid_redirect_uri");

  const identity = await createIdentity(app, "Владелец", "Дом");
  const client = await registerClient(app);
  const verifier = "mcp-test-verifier-that-is-long-enough-for-pkce-1234567890";
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const query = new URLSearchParams({
    response_type: "code", client_id: client.clientId, redirect_uri: client.redirectUri, scope: "history:read",
    code_challenge: challenge, code_challenge_method: "S256", resource: mcpResource(app)
  });
  const crossSiteStart = await app.inject({ method: "GET", url: `/oauth/authorize?${query}` });
  assert.equal(crossSiteStart.statusCode, 401);
  assert.match(crossSiteStart.body, /Продолжить/);

  const authorization = await authorize(app, identity, client);
  const wrongVerifier = await exchangeCode(app, client, authorization.code, `${authorization.verifier}x`);
  assert.equal(wrongVerifier.statusCode, 400);
  assert.equal(wrongVerifier.json().error, "invalid_grant");
  const tokenResponse = await exchangeCode(app, client, authorization.code, authorization.verifier);
  assert.equal(tokenResponse.statusCode, 200, tokenResponse.body);
  const tokens = tokenResponse.json() as { access_token: string; refresh_token: string; expires_in: number; resource: string };
  assert.equal(tokens.expires_in, 3600);
  assert.equal(tokens.resource, mcpResource(app));
  assert.equal(app.db.prepare("SELECT 1 FROM oauth_tokens WHERE access_token_hash=? AND refresh_token_hash=?")
    .get(hashSecret(tokens.access_token), hashSecret(tokens.refresh_token)) !== undefined, true);
  assert.equal(app.db.prepare("SELECT 1 FROM oauth_tokens WHERE access_token_hash=? OR refresh_token_hash=?")
    .get(tokens.access_token, tokens.refresh_token), undefined);
  const replay = await exchangeCode(app, client, authorization.code, authorization.verifier);
  assert.equal(replay.statusCode, 400);
  assert.equal(replay.json().error, "invalid_grant");

  const refreshed = await app.inject({
    method: "POST",
    url: "/oauth/token",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    payload: new URLSearchParams({ grant_type: "refresh_token", client_id: client.clientId, refresh_token: tokens.refresh_token, resource: mcpResource(app) }).toString()
  });
  assert.equal(refreshed.statusCode, 200, refreshed.body);
  assert.notEqual(refreshed.json().access_token, tokens.access_token);
  const oldAccess = await app.inject({ method: "GET", url: "/mcp", headers: { authorization: `Bearer ${tokens.access_token}` } });
  assert.equal(oldAccess.statusCode, 401);
  assert.match(String(oldAccess.headers["www-authenticate"]), /invalid_token/);
});

test("OAuth consent accepts opaque or missing Origin only with its signed session-bound form token", async () => {
  const app = await buildTestApp({ plugins: [registerOAuthRoutes, registerMcpRoutes] });
  apps.push(app);
  const identity = await createIdentity(app, "Владелец", "Дом");
  const client = await registerClient(app);

  const opaqueOrigin = await authorize(app, identity, client, "null");
  assert.ok(opaqueOrigin.code);
  const missingOrigin = await authorize(app, identity, client, null);
  assert.ok(missingOrigin.code);

  const foreignOrigin = await submitAuthorization(app, identity, client, "https://attacker.example");
  assert.equal(foreignOrigin.approved.statusCode, 400);
  assert.match(foreignOrigin.approved.body, /Request origin is not allowed/);

  const forged = new URLSearchParams({
    response_type: "code",
    client_id: client.clientId,
    redirect_uri: client.redirectUri,
    scope: "history:read",
    code_challenge: createHash("sha256").update("mcp-test-verifier-that-is-long-enough-for-pkce-1234567890").digest("base64url"),
    code_challenge_method: "S256",
    resource: mcpResource(app),
    decision: "approve",
    csrf_token: "forged.token"
  });
  const rejected = await app.inject({
    method: "POST",
    url: "/oauth/authorize",
    headers: { cookie: identity.cookie, "content-type": "application/x-www-form-urlencoded" },
    payload: forged.toString()
  });
  assert.equal(rejected.statusCode, 400);
  assert.match(rejected.body, /Authorization form is invalid or expired/);
});

test("MCP exposes paginated read-only history and rechecks workspace membership", async () => {
  const app = await buildTestApp({ plugins: [registerOAuthRoutes, registerMcpRoutes] });
  apps.push(app);
  const owner = await createIdentity(app, "Первый", "Дом");
  const foreign = await createIdentity(app, "Второй", "Секретное пространство");
  const now = "2026-08-30T12:00:00.000Z";
  const insertExpense = app.db.prepare(`INSERT INTO expenses
    (workspace_id,id,amount_minor,currency,category_id,occurred_at,note,version,created_at,updated_at,deleted_at)
    VALUES (?,?,?,?,?,?,?,1,?,?,?)`);
  insertExpense.run(owner.workspaceId, "owner-eur", 1234, "EUR", "products", "2026-08-29T22:30:00.000Z", "кофе", now, now, null);
  insertExpense.run(owner.workspaceId, "owner-rsd", 5000, "RSD", "products", "2026-08-31T10:00:00.000Z", null, now, now, null);
  insertExpense.run(owner.workspaceId, "owner-deleted", 999, "EUR", "products", "2026-08-30T10:00:00.000Z", "deleted", now, now, now);
  insertExpense.run(foreign.workspaceId, "foreign-secret", 7777, "EUR", "products", "2026-08-30T10:00:00.000Z", "never expose", now, now, null);

  const client = await registerClient(app);
  const authorization = await authorize(app, owner, client);
  const tokenResponse = await exchangeCode(app, client, authorization.code, authorization.verifier);
  assert.equal(tokenResponse.statusCode, 200, tokenResponse.body);
  const accessToken = tokenResponse.json().access_token as string;

  const initialize = await mcpRequest(app, accessToken, 1, "initialize", {
    protocolVersion: "2025-11-25",
    capabilities: {},
    clientInfo: { name: "test", version: "1.0.0" }
  });
  assert.equal(initialize.statusCode, 200, initialize.body);
  assert.equal(initialize.json().result.serverInfo.name, "moapp-expense-history");

  const tools = await mcpRequest(app, accessToken, 2, "tools/list", {});
  assert.equal(tools.statusCode, 200, tools.body);
  assert.deepEqual(tools.json().result.tools.map((tool: { name: string }) => tool.name), ["list_workspaces", "get_expense_history"]);
  assert.deepEqual(tools.json().result.tools[0]._meta.securitySchemes, [{ type: "oauth2", scopes: ["history:read"] }]);

  const workspaces = await mcpRequest(app, accessToken, 3, "tools/call", { name: "list_workspaces", arguments: {} });
  assert.equal(workspaces.statusCode, 200, workspaces.body);
  assert.deepEqual(workspaces.json().result.structuredContent.workspaces, [{ id: owner.workspaceId, name: "Дом", role: "owner" }]);

  const history = await mcpRequest(app, accessToken, 4, "tools/call", { name: "get_expense_history", arguments: {
    workspaceId: owner.workspaceId,
    from: "2026-08-30",
    to: "2026-08-30",
    currency: "EUR",
    limit: 1
  } });
  assert.equal(history.statusCode, 200, history.body);
  assert.deepEqual(history.json().result.structuredContent.expenses, [{
    id: "owner-eur",
    occurredAt: "2026-08-29T22:30:00.000Z",
    date: "2026-08-30",
    amountMinor: 1234,
    amount: "12.34",
    currency: "EUR",
    categoryId: "products",
    category: "Продукты",
    tagIds: [],
    tags: [],
    note: "кофе"
  }]);
  assert.equal(history.json().result.structuredContent.nextCursor, null);
  assert.doesNotMatch(history.body, /owner-deleted|never expose/);

  const forbidden = await mcpRequest(app, accessToken, 5, "tools/call", { name: "get_expense_history", arguments: { workspaceId: foreign.workspaceId } });
  assert.equal(forbidden.statusCode, 200, forbidden.body);
  assert.equal(forbidden.json().result.isError, true);
  assert.equal(forbidden.json().result.content[0].text, "Workspace not found.");
  assert.doesNotMatch(forbidden.body, /Секретное пространство|never expose/);

  app.db.transaction(() => {
    app.db.prepare("INSERT INTO memberships(workspace_id,user_id,joined_at,added_by_user_id) VALUES (?,?,?,?)")
      .run(owner.workspaceId, foreign.userId, now, owner.userId);
    app.db.prepare("UPDATE workspaces SET owner_user_id=? WHERE id=?").run(foreign.userId, owner.workspaceId);
    app.db.prepare("DELETE FROM memberships WHERE workspace_id=? AND user_id=?").run(owner.workspaceId, owner.userId);
  })();
  const afterRemoval = await mcpRequest(app, accessToken, 6, "tools/call", { name: "get_expense_history", arguments: { workspaceId: owner.workspaceId } });
  assert.equal(afterRemoval.json().result.isError, true);
  assert.equal(afterRemoval.json().result.content[0].text, "Workspace not found.");
});
