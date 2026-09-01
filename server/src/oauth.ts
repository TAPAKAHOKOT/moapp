import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { Database } from "better-sqlite3";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { hashSecret } from "./auth.js";
import { listWorkspaceSummaries } from "./users.js";

const MCP_SCOPE = "history:read";
const AUTHORIZATION_CODE_TTL_MS = 5 * 60_000;
const ACCESS_TOKEN_TTL_SECONDS = 60 * 60;
const REFRESH_TOKEN_TTL_MS = 30 * 86_400_000;
const REDIRECT_URI_LIMIT = 10;

type OAuthClientRow = {
  client_id: string;
  redirect_uris_json: string;
  client_name: string;
  created_at: string;
};

type AuthorizationCodeRow = {
  code_hash: string;
  client_id: string;
  user_id: string;
  redirect_uri: string;
  scope: string;
  code_challenge: string;
  resource: string;
  created_at: string;
  expires_at: string;
  consumed_at: string | null;
};

export type OAuthTokenRow = {
  access_token_hash: string;
  refresh_token_hash: string;
  client_id: string;
  user_id: string;
  scope: string;
  resource: string;
  created_at: string;
  access_expires_at: string;
  refresh_expires_at: string;
  revoked_at: string | null;
};

type AuthorizationInput = {
  responseType: "code";
  client: OAuthClientRow;
  redirectUri: string;
  scope: typeof MCP_SCOPE;
  state?: string;
  codeChallenge: string;
  resource: string;
};

function noStore(reply: FastifyReply): FastifyReply {
  return reply.header("Cache-Control", "no-store").header("Pragma", "no-cache");
}

export function mcpResource(app: FastifyInstance): string {
  return `${app.config.appOrigin}/mcp`;
}

export function protectedResourceMetadataUrl(app: FastifyInstance): string {
  return `${app.config.appOrigin}/.well-known/oauth-protected-resource`;
}

function oauthError(reply: FastifyReply, status: number, error: string, description: string): FastifyReply {
  return noStore(reply).code(status).send({ error, error_description: description });
}

function htmlEscape(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  })[character]!);
}

function page(title: string, content: string): string {
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${htmlEscape(title)} · Moapp</title><style>
    :root{color-scheme:light dark;font-family:Inter,ui-sans-serif,system-ui,sans-serif;background:#f6f7f3;color:#20251f}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:20px;box-sizing:border-box}.card{width:min(100%,460px);background:#fff;border:1px solid #dfe4dc;border-radius:24px;padding:28px;box-sizing:border-box;box-shadow:0 18px 50px #27312414}.brand{width:42px;height:42px;border-radius:14px;display:grid;place-items:center;background:#758d69;color:#fff;font-size:24px;font-weight:800}h1{font-size:24px;margin:22px 0 10px}p,li{color:#626960;line-height:1.5;font-size:14px}ul{padding-left:20px}.actions{display:flex;gap:10px;margin-top:24px;flex-wrap:wrap}button,.button{appearance:none;border:0;border-radius:14px;padding:13px 18px;font:700 14px inherit;text-decoration:none;cursor:pointer;background:#758d69;color:#fff}.secondary{background:#eef1eb;color:#4e594a}.muted{font-size:12px}.error{color:#a13f37}@media(prefers-color-scheme:dark){:root{background:#181b18;color:#edf0e9}.card{background:#232722;border-color:#3a4039}.secondary{background:#2e352d;color:#dfe6dc}p,li{color:#a6aaa1}}
  </style></head><body><main class="card"><div class="brand">m</div>${content}</main></body></html>`;
}

function sendPage(reply: FastifyReply, status: number, title: string, content: string): FastifyReply {
  return noStore(reply).code(status).type("text/html; charset=utf-8").send(page(title, content));
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function validRedirectUri(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 2048) return false;
  try {
    const url = new URL(value);
    const localHttp = url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]");
    return (url.protocol === "https:" || localHttp)
      && url.username === "" && url.password === "" && url.hash === "";
  } catch {
    return false;
  }
}

function redirectUris(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.length < 1 || value.length > REDIRECT_URI_LIMIT) return undefined;
  if (!value.every(validRedirectUri)) return undefined;
  const unique = [...new Set(value)];
  return unique.length === value.length ? unique : undefined;
}

function clientRedirectUris(client: OAuthClientRow): string[] {
  const parsed = JSON.parse(client.redirect_uris_json) as unknown;
  if (!Array.isArray(parsed) || !parsed.every((value) => typeof value === "string")) throw new Error(`OAuth client ${client.client_id} has invalid redirect URIs`);
  return parsed;
}

function clientById(app: FastifyInstance, clientId: string | undefined): OAuthClientRow | undefined {
  if (!clientId) return undefined;
  return app.db.prepare("SELECT * FROM oauth_clients WHERE client_id=?").get(clientId) as OAuthClientRow | undefined;
}

function authorizationInput(app: FastifyInstance, raw: Record<string, unknown>): AuthorizationInput | { error: string; description: string; redirectUri?: string; state?: string } {
  const clientId = stringValue(raw.client_id);
  const client = clientById(app, clientId);
  if (!client) return { error: "invalid_client", description: "OAuth client is not registered" };
  const redirectUri = stringValue(raw.redirect_uri);
  if (!redirectUri || !clientRedirectUris(client).includes(redirectUri)) {
    return { error: "invalid_request", description: "redirect_uri is not registered for this client" };
  }
  const state = stringValue(raw.state);
  const redirectError = (error: string, description: string) => ({
    error,
    description,
    redirectUri,
    ...(state === undefined ? {} : { state })
  });
  if (state !== undefined && state.length > 2048) return redirectError("invalid_request", "state is too long");
  if (raw.response_type !== "code") return redirectError("unsupported_response_type", "Only the authorization code flow is supported");
  if (raw.scope !== MCP_SCOPE) return redirectError("invalid_scope", `The requested scope must be ${MCP_SCOPE}`);
  const codeChallenge = stringValue(raw.code_challenge);
  if (raw.code_challenge_method !== "S256" || !codeChallenge || !/^[A-Za-z0-9_-]{43}$/.test(codeChallenge)) {
    return redirectError("invalid_request", "S256 PKCE is required");
  }
  const resource = stringValue(raw.resource);
  if (resource !== mcpResource(app)) return redirectError("invalid_target", "The OAuth resource does not match this MCP server");
  return {
    responseType: "code",
    client,
    redirectUri,
    scope: MCP_SCOPE,
    ...(state === undefined ? {} : { state }),
    codeChallenge,
    resource
  };
}

function redirectAuthorizationResult(app: FastifyInstance, reply: FastifyReply, redirectUri: string, values: Record<string, string | undefined>): FastifyReply {
  const target = new URL(redirectUri);
  for (const [key, value] of Object.entries(values)) if (value !== undefined) target.searchParams.set(key, value);
  target.searchParams.set("iss", app.config.appOrigin);
  return noStore(reply).redirect(target.toString());
}

function hidden(name: string, value: string | undefined): string {
  return value === undefined ? "" : `<input type="hidden" name="${htmlEscape(name)}" value="${htmlEscape(value)}">`;
}

function authorizationFields(input: AuthorizationInput): string {
  return [
    hidden("response_type", input.responseType),
    hidden("client_id", input.client.client_id),
    hidden("redirect_uri", input.redirectUri),
    hidden("scope", input.scope),
    hidden("state", input.state),
    hidden("code_challenge", input.codeChallenge),
    hidden("code_challenge_method", "S256"),
    hidden("resource", input.resource)
  ].join("");
}

function retryUrl(app: FastifyInstance, input: AuthorizationInput): string {
  const target = new URL("/oauth/authorize", app.config.appOrigin);
  const fields: Record<string, string | undefined> = {
    response_type: input.responseType,
    client_id: input.client.client_id,
    redirect_uri: input.redirectUri,
    scope: input.scope,
    state: input.state,
    code_challenge: input.codeChallenge,
    code_challenge_method: "S256",
    resource: input.resource,
    continue: "1"
  };
  for (const [key, value] of Object.entries(fields)) if (value !== undefined) target.searchParams.set(key, value);
  return target.toString();
}

function authorizationErrorPage(reply: FastifyReply, error: string, description: string): FastifyReply {
  return sendPage(reply, 400, "Ошибка подключения", `<h1>Не удалось подключить MCP</h1><p class="error">${htmlEscape(description)}</p><p class="muted">Код: ${htmlEscape(error)}</p>`);
}

function issueTokenPair(db: Database, input: { clientId: string; userId: string; scope: string; resource: string; now: Date }): { accessToken: string; refreshToken: string; accessExpiresAt: string; refreshExpiresAt: string } {
  const accessToken = randomBytes(32).toString("base64url");
  const refreshToken = randomBytes(32).toString("base64url");
  const createdAt = input.now.toISOString();
  const accessExpiresAt = new Date(input.now.getTime() + ACCESS_TOKEN_TTL_SECONDS * 1000).toISOString();
  const refreshExpiresAt = new Date(input.now.getTime() + REFRESH_TOKEN_TTL_MS).toISOString();
  db.prepare(`INSERT INTO oauth_tokens
    (access_token_hash,refresh_token_hash,client_id,user_id,scope,resource,created_at,access_expires_at,refresh_expires_at,revoked_at)
    VALUES (?,?,?,?,?,?,?,?,?,NULL)`)
    .run(hashSecret(accessToken), hashSecret(refreshToken), input.clientId, input.userId, input.scope, input.resource, createdAt, accessExpiresAt, refreshExpiresAt);
  return { accessToken, refreshToken, accessExpiresAt, refreshExpiresAt };
}

function tokenResponse(reply: FastifyReply, tokens: { accessToken: string; refreshToken: string }, scope: string, resource: string): FastifyReply {
  return noStore(reply).send({
    access_token: tokens.accessToken,
    token_type: "Bearer",
    expires_in: ACCESS_TOKEN_TTL_SECONDS,
    refresh_token: tokens.refreshToken,
    scope,
    resource
  });
}

function pkceMatches(verifier: string, challenge: string): boolean {
  if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) return false;
  const actual = createHash("sha256").update(verifier).digest("base64url");
  const actualBytes = Buffer.from(actual);
  const challengeBytes = Buffer.from(challenge);
  return actualBytes.length === challengeBytes.length && timingSafeEqual(actualBytes, challengeBytes);
}

function parseFormBody(body: unknown): Record<string, unknown> {
  return body !== null && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : {};
}

export function activeOAuthToken(db: Database, token: string, resource: string, now = new Date().toISOString()): OAuthTokenRow | undefined {
  return db.prepare(`SELECT * FROM oauth_tokens
    WHERE access_token_hash=? AND revoked_at IS NULL AND access_expires_at>? AND resource=?`)
    .get(hashSecret(token), now, resource) as OAuthTokenRow | undefined;
}

export function cleanupExpiredOAuthRows(db: Database, now = new Date()): void {
  const nowIso = now.toISOString();
  const retention = new Date(now.getTime() - 86_400_000).toISOString();
  db.prepare("DELETE FROM oauth_authorization_codes WHERE expires_at<=? OR (consumed_at IS NOT NULL AND consumed_at<=?)").run(nowIso, retention);
  db.prepare("DELETE FROM oauth_tokens WHERE refresh_expires_at<=? OR (revoked_at IS NOT NULL AND revoked_at<=?)").run(nowIso, retention);
}

export async function registerOAuthRoutes(app: FastifyInstance): Promise<void> {
  app.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "string" }, (_request, body, done) => {
    try {
      done(null, Object.fromEntries(new URLSearchParams(body.toString())));
    } catch (error) {
      done(error as Error);
    }
  });

  const metadata = () => ({
    issuer: app.config.appOrigin,
    authorization_endpoint: `${app.config.appOrigin}/oauth/authorize`,
    token_endpoint: `${app.config.appOrigin}/oauth/token`,
    registration_endpoint: `${app.config.appOrigin}/oauth/register`,
    revocation_endpoint: `${app.config.appOrigin}/oauth/revoke`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    scopes_supported: [MCP_SCOPE],
    authorization_response_iss_parameter_supported: true
  });
  const resourceMetadata = () => ({
    resource: mcpResource(app),
    authorization_servers: [app.config.appOrigin],
    scopes_supported: [MCP_SCOPE],
    bearer_methods_supported: ["header"],
    resource_documentation: `${app.config.appOrigin}/#mcp`
  });

  app.get("/.well-known/oauth-authorization-server", async (_request, reply) => noStore(reply).send(metadata()));
  app.get("/.well-known/oauth-protected-resource", async (_request, reply) => noStore(reply).send(resourceMetadata()));
  app.get("/.well-known/oauth-protected-resource/mcp", async (_request, reply) => noStore(reply).send(resourceMetadata()));

  app.post("/oauth/register", {
    config: { rateLimit: { max: 20, timeWindow: "1 hour" } }
  }, async (request, reply) => {
    const body = parseFormBody(request.body);
    const uris = redirectUris(body.redirect_uris);
    if (!uris) return oauthError(reply, 400, "invalid_redirect_uri", "redirect_uris must contain unique HTTPS callback URLs");
    if (body.token_endpoint_auth_method !== undefined && body.token_endpoint_auth_method !== "none") {
      return oauthError(reply, 400, "invalid_client_metadata", "Only public clients with token_endpoint_auth_method=none are supported");
    }
    const grantTypes = body.grant_types ?? ["authorization_code", "refresh_token"];
    if (!Array.isArray(grantTypes) || !grantTypes.includes("authorization_code")
      || grantTypes.some((value) => value !== "authorization_code" && value !== "refresh_token")) {
      return oauthError(reply, 400, "invalid_client_metadata", "Only authorization_code and refresh_token grants are supported");
    }
    const responseTypes = body.response_types ?? ["code"];
    if (!Array.isArray(responseTypes) || responseTypes.length !== 1 || responseTypes[0] !== "code") {
      return oauthError(reply, 400, "invalid_client_metadata", "Only response_type=code is supported");
    }
    const rawName = body.client_name === undefined ? "ChatGPT MCP client" : body.client_name;
    const clientName = typeof rawName === "string" ? rawName.normalize("NFKC").trim() : "";
    if (!clientName || Array.from(clientName).length > 100 || /[\p{Cc}\p{Cf}]/u.test(clientName)) {
      return oauthError(reply, 400, "invalid_client_metadata", "client_name must contain 1-100 printable characters");
    }
    const clientId = randomUUID();
    const createdAt = new Date();
    app.db.prepare("INSERT INTO oauth_clients(client_id,redirect_uris_json,client_name,created_at) VALUES (?,?,?,?)")
      .run(clientId, JSON.stringify(uris), clientName, createdAt.toISOString());
    return noStore(reply).code(201).send({
      client_id: clientId,
      client_id_issued_at: Math.floor(createdAt.getTime() / 1000),
      client_name: clientName,
      redirect_uris: uris,
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      scope: MCP_SCOPE
    });
  });

  app.get("/oauth/authorize", { preHandler: app.optionalAuth }, async (request, reply) => {
    const raw = request.query as Record<string, unknown>;
    const input = authorizationInput(app, raw);
    if ("error" in input) {
      return input.redirectUri
        ? redirectAuthorizationResult(app, reply, input.redirectUri, { error: input.error, error_description: input.description, state: input.state })
        : authorizationErrorPage(reply, input.error, input.description);
    }
    if (!request.auth || request.auth.sessionKind !== "normal") {
      const retry = retryUrl(app, input);
      const continued = raw.continue === "1";
      return sendPage(reply, 401, "Подключение MCP", `<h1>Подключить ChatGPT к Moapp</h1><p>${continued ? "В этом браузере нет активного профиля Moapp." : "Чтобы браузер безопасно передал текущую Moapp-сессию, подтвердите переход ещё раз."}</p><div class="actions"><a class="button" href="${htmlEscape(retry)}">${continued ? "Проверить снова" : "Продолжить"}</a><a class="button secondary" href="${htmlEscape(app.config.appOrigin)}" target="_blank" rel="noopener">Открыть Moapp</a></div><p class="muted">Если профиль открыт на другом устройстве, сначала восстановите его в этом браузере, затем вернитесь на эту страницу.</p>`);
    }
    const profile = app.db.prepare("SELECT display_name FROM users WHERE id=?").get(request.auth.userId) as { display_name: string } | undefined;
    const workspaces = listWorkspaceSummaries(app.db, request.auth.userId);
    return sendPage(reply, 200, "Разрешить доступ", `<h1>Разрешить доступ к истории?</h1><p><strong>${htmlEscape(input.client.client_name)}</strong> получит доступ к профилю ${htmlEscape(profile?.display_name ?? "Moapp")}.</p><ul><li>только чтение истории расходов;</li><li>все пространства, участником которых остаётся профиль;</li><li>без создания, изменения и удаления расходов.</li></ul><p class="muted">Получатель авторизации: ${htmlEscape(new URL(input.redirectUri).origin)}.<br>Сейчас доступно пространств: ${workspaces.length}${workspaces.length ? ` — ${workspaces.map((workspace) => htmlEscape(workspace.name)).join(", ")}` : ""}.</p><form method="post" action="/oauth/authorize">${authorizationFields(input)}<div class="actions"><button type="submit" name="decision" value="approve">Разрешить</button><button class="secondary" type="submit" name="decision" value="deny">Отмена</button></div></form>`);
  });

  app.post("/oauth/authorize", { preHandler: app.optionalAuth }, async (request, reply) => {
    if (request.headers.origin !== app.config.appOrigin) return authorizationErrorPage(reply, "access_denied", "Request origin is not allowed");
    const raw = parseFormBody(request.body);
    const input = authorizationInput(app, raw);
    if ("error" in input) {
      return input.redirectUri
        ? redirectAuthorizationResult(app, reply, input.redirectUri, { error: input.error, error_description: input.description, state: input.state })
        : authorizationErrorPage(reply, input.error, input.description);
    }
    if (!request.auth || request.auth.sessionKind !== "normal") {
      return sendPage(reply, 401, "Нужен профиль", `<h1>Сессия Moapp не найдена</h1><p>Откройте Moapp в этом браузере и повторите подключение.</p>`);
    }
    if (raw.decision === "deny") {
      return redirectAuthorizationResult(app, reply, input.redirectUri, { error: "access_denied", state: input.state });
    }
    if (raw.decision !== "approve") return authorizationErrorPage(reply, "invalid_request", "Choose whether to allow access");
    const code = randomBytes(32).toString("base64url");
    const now = new Date();
    app.db.prepare(`INSERT INTO oauth_authorization_codes
      (code_hash,client_id,user_id,redirect_uri,scope,code_challenge,resource,created_at,expires_at,consumed_at)
      VALUES (?,?,?,?,?,?,?,?,?,NULL)`)
      .run(hashSecret(code), input.client.client_id, request.auth.userId, input.redirectUri, input.scope,
        input.codeChallenge, input.resource, now.toISOString(), new Date(now.getTime() + AUTHORIZATION_CODE_TTL_MS).toISOString());
    return redirectAuthorizationResult(app, reply, input.redirectUri, { code, state: input.state });
  });

  app.post("/oauth/token", async (request, reply) => {
    const body = parseFormBody(request.body);
    const grantType = stringValue(body.grant_type);
    const clientId = stringValue(body.client_id);
    const client = clientById(app, clientId);
    if (!client) return oauthError(reply, 401, "invalid_client", "OAuth client is not registered");
    if (grantType === "authorization_code") {
      const code = stringValue(body.code);
      const redirectUri = stringValue(body.redirect_uri);
      const verifier = stringValue(body.code_verifier);
      const resource = stringValue(body.resource);
      if (!code || !redirectUri || !verifier || !resource) return oauthError(reply, 400, "invalid_request", "code, redirect_uri, code_verifier and resource are required");
      const now = new Date();
      const row = app.db.prepare("SELECT * FROM oauth_authorization_codes WHERE code_hash=?")
        .get(hashSecret(code)) as AuthorizationCodeRow | undefined;
      if (!row || row.client_id !== client.client_id || row.redirect_uri !== redirectUri || row.resource !== resource
        || row.resource !== mcpResource(app) || row.consumed_at !== null || row.expires_at <= now.toISOString()
        || !pkceMatches(verifier, row.code_challenge)) {
        return oauthError(reply, 400, "invalid_grant", "Authorization code is invalid, expired, consumed, or PKCE verification failed");
      }
      const result = app.db.transaction(() => {
        const consumed = app.db.prepare("UPDATE oauth_authorization_codes SET consumed_at=? WHERE code_hash=? AND consumed_at IS NULL AND expires_at>?")
          .run(now.toISOString(), row.code_hash, now.toISOString());
        if (consumed.changes !== 1) return undefined;
        return issueTokenPair(app.db, { clientId: row.client_id, userId: row.user_id, scope: row.scope, resource: row.resource, now });
      })();
      return result ? tokenResponse(reply, result, row.scope, row.resource) : oauthError(reply, 400, "invalid_grant", "Authorization code was already consumed");
    }
    if (grantType === "refresh_token") {
      const refreshToken = stringValue(body.refresh_token);
      if (!refreshToken) return oauthError(reply, 400, "invalid_request", "refresh_token is required");
      const now = new Date();
      const row = app.db.prepare("SELECT * FROM oauth_tokens WHERE refresh_token_hash=?")
        .get(hashSecret(refreshToken)) as OAuthTokenRow | undefined;
      const requestedResource = stringValue(body.resource);
      const requestedScope = stringValue(body.scope);
      if (!row || row.client_id !== client.client_id || row.revoked_at !== null || row.refresh_expires_at <= now.toISOString()
        || row.resource !== mcpResource(app) || (requestedResource !== undefined && requestedResource !== row.resource)
        || (requestedScope !== undefined && requestedScope !== row.scope)) {
        return oauthError(reply, 400, "invalid_grant", "Refresh token is invalid, expired, revoked, or cannot grant the requested access");
      }
      const result = app.db.transaction(() => {
        const revoked = app.db.prepare("UPDATE oauth_tokens SET revoked_at=? WHERE refresh_token_hash=? AND revoked_at IS NULL AND refresh_expires_at>?")
          .run(now.toISOString(), row.refresh_token_hash, now.toISOString());
        if (revoked.changes !== 1) return undefined;
        return issueTokenPair(app.db, { clientId: row.client_id, userId: row.user_id, scope: row.scope, resource: row.resource, now });
      })();
      return result ? tokenResponse(reply, result, row.scope, row.resource) : oauthError(reply, 400, "invalid_grant", "Refresh token was already rotated");
    }
    return oauthError(reply, 400, "unsupported_grant_type", "Only authorization_code and refresh_token grants are supported");
  });

  app.post("/oauth/revoke", async (request, reply) => {
    const body = parseFormBody(request.body);
    const clientId = stringValue(body.client_id);
    const token = stringValue(body.token);
    if (!clientById(app, clientId)) return oauthError(reply, 401, "invalid_client", "OAuth client is not registered");
    if (!token) return oauthError(reply, 400, "invalid_request", "token is required");
    const hash = hashSecret(token);
    app.db.prepare(`UPDATE oauth_tokens SET revoked_at=COALESCE(revoked_at,?)
      WHERE client_id=? AND (access_token_hash=? OR refresh_token_hash=?)`)
      .run(new Date().toISOString(), clientId, hash, hash);
    return noStore(reply).send({});
  });
}
