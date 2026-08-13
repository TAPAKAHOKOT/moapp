import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Database } from "better-sqlite3";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { AppConfig, AuthPrincipal, SessionKind, SessionRow } from "./types.js";
import { jsonError } from "./validation.js";

const EXPECTED_USER_HEADER = "x-moapp-expected-user-id";
const EXPECTED_SESSION_HEADER = "x-moapp-expected-session-id";
const SLIDING_REFRESH_INTERVAL_MS = 60 * 60 * 1000;

export type CreatedSession = {
  token: string;
  principal: AuthPrincipal;
  id: string;
  userId: string;
  kind: SessionKind;
  label: string;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
};

export function hashSecret(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

export function sessionCookieName(config: AppConfig): string {
  return config.secureCookies ? "__Host-moapp_session" : "moapp_session";
}

function cookieOptions(config: AppConfig, expires?: Date) {
  return {
    signed: true,
    httpOnly: true,
    secure: config.secureCookies,
    sameSite: "strict" as const,
    path: "/",
    ...(expires === undefined ? {} : { expires })
  };
}

export function setSessionCookie(reply: FastifyReply, config: AppConfig, session: Pick<CreatedSession, "token" | "expiresAt">): FastifyReply {
  return reply.setCookie(sessionCookieName(config), session.token, cookieOptions(config, new Date(session.expiresAt)));
}

export function clearSessionCookie(reply: FastifyReply, config: AppConfig): FastifyReply {
  return reply.clearCookie(sessionCookieName(config), cookieOptions(config));
}

function sessionLabel(userAgent: string | undefined): string {
  const ua = userAgent ?? "";
  const browser = /Edg\//.test(ua) ? "Edge" : /Firefox\//.test(ua) ? "Firefox" : /CriOS\//.test(ua) ? "Chrome" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : "Browser";
  const platform = /iPhone|iPad/.test(ua) ? "iOS" : /Android/.test(ua) ? "Android" : /Macintosh|Mac OS X/.test(ua) ? "macOS" : /Windows/.test(ua) ? "Windows" : /Linux/.test(ua) ? "Linux" : "unknown device";
  return `${browser} on ${platform}`.slice(0, 80);
}

export function createSession(
  db: Database,
  config: AppConfig,
  input: { userId: string; kind?: SessionKind; userAgent?: string | undefined; now?: Date; expiresAt?: Date }
): CreatedSession {
  const now = input.now ?? new Date();
  const expires = input.expiresAt ?? new Date(now.getTime() + config.sessionTtlDays * 86_400_000);
  const token = randomBytes(32).toString("base64url");
  const id = randomUUID();
  const kind = input.kind ?? "normal";
  const createdAt = now.toISOString();
  const expiresAt = expires.toISOString();
  const label = sessionLabel(input.userAgent);
  db.prepare(`INSERT INTO sessions
    (id,token_hash,user_id,kind,label,created_at,last_seen_at,expires_at,revoked_at)
    VALUES (?,?,?,?,?,?,?,?,NULL)`)
    .run(id, hashSecret(token), input.userId, kind, label, createdAt, createdAt, expiresAt);
  return {
    token,
    principal: { userId: input.userId, sessionId: id, sessionKind: kind, expiresAt },
    id,
    userId: input.userId,
    kind,
    label,
    createdAt,
    lastSeenAt: createdAt,
    expiresAt
  };
}

export function revokeSessionInTransaction(db: Database, sessionId: string, now = new Date().toISOString()): boolean {
  const revoked = db.prepare("UPDATE sessions SET revoked_at=? WHERE id=? AND revoked_at IS NULL").run(now, sessionId);
  db.prepare(`UPDATE access_tokens SET revoked_at=?
    WHERE revoked_at IS NULL AND expires_at>? AND (
      (created_by_session_id=? AND kind='device_link')
      OR (created_by_session_id=? AND kind='invitation' AND consumed_at IS NULL)
      OR (created_by_session_id=? AND kind='recovery_rotation' AND consumed_at IS NULL)
      OR (accepted_session_id=? AND kind='device_link')
    )`).run(now, now, sessionId, sessionId, sessionId, sessionId);
  return revoked.changes > 0;
}

export function revokeSession(db: Database, sessionId: string, now = new Date().toISOString()): boolean {
  return db.transaction(() => revokeSessionInTransaction(db, sessionId, now))();
}

function contextMatches(request: FastifyRequest): boolean {
  const auth = request.auth;
  return auth !== undefined
    && request.headers[EXPECTED_USER_HEADER] === auth.userId
    && request.headers[EXPECTED_SESSION_HEADER] === auth.sessionId;
}

export async function requireExpectedSessionContext(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (contextMatches(request)) return;
  await reply.code(409).send(jsonError("SESSION_CONTEXT_CHANGED", "The active session no longer matches this client context"));
}

function restrictedSessionIsCurrent(db: Database, sessionId: string, now: string): boolean {
  return db.prepare(`SELECT 1 FROM legacy_claims
    WHERE state='claimed_pending' AND pending_session_id=? AND pending_expires_at>?`).get(sessionId, now) !== undefined;
}

function activeSessionByToken(db: Database, token: string): SessionRow | undefined {
  return db.prepare("SELECT * FROM sessions WHERE token_hash=?").get(hashSecret(token)) as SessionRow | undefined;
}

export function refreshNormalSession(app: FastifyInstance, request: FastifyRequest, reply: FastifyReply, now = new Date()): void {
  if (!request.auth || request.auth.sessionKind !== "normal") return;
  const session = app.db.prepare("SELECT last_seen_at,expires_at FROM sessions WHERE id=? AND revoked_at IS NULL").get(request.auth.sessionId) as {
    last_seen_at: string;
    expires_at: string;
  } | undefined;
  if (!session || Date.parse(session.last_seen_at) > now.getTime() - SLIDING_REFRESH_INTERVAL_MS) return;
  const token = readCookie(request, app.config);
  if (!token) return;
  const nowIso = now.toISOString();
  const expiresAt = new Date(now.getTime() + app.config.sessionTtlDays * 86_400_000).toISOString();
  const updated = app.db.prepare(`UPDATE sessions SET last_seen_at=?,expires_at=?
    WHERE id=? AND revoked_at IS NULL AND expires_at>? AND last_seen_at=?`)
    .run(nowIso, expiresAt, request.auth.sessionId, nowIso, session.last_seen_at);
  if (updated.changes > 0) {
    request.auth.expiresAt = expiresAt;
    setSessionCookie(reply, app.config, { token, expiresAt });
  }
}

function readCookie(request: FastifyRequest, config: AppConfig): string | undefined {
  const raw = request.cookies[sessionCookieName(config)];
  if (!raw) return undefined;
  const unsigned = request.unsignCookie(raw);
  return unsigned.valid && unsigned.value ? unsigned.value : undefined;
}

export async function registerAuth(app: FastifyInstance): Promise<void> {
  const unfinishedLegacyClaim = app.db.prepare("SELECT 1 FROM legacy_claims WHERE state IN ('open','claimed_pending') LIMIT 1").get();
  if (unfinishedLegacyClaim && !app.config.pin) throw new Error("APP_PIN is required while the legacy claim is open or pending");

  app.decorateRequest("auth");
  app.decorateRequest("workspaceAccess");

  app.decorate("optionalAuth", async (request: FastifyRequest, reply: FastifyReply) => {
    delete request.auth;
    const raw = request.cookies[sessionCookieName(app.config)];
    if (!raw) return;
    const token = readCookie(request, app.config);
    if (!token) {
      clearSessionCookie(reply, app.config);
      return;
    }
    const session = activeSessionByToken(app.db, token);
    const now = new Date();
    const nowIso = now.toISOString();
    const restrictedIsInvalid = session?.kind === "legacy_claim_pending" && !restrictedSessionIsCurrent(app.db, session.id, nowIso);
    if (!session || session.revoked_at !== null || session.expires_at <= nowIso || restrictedIsInvalid) {
      if (session?.kind === "legacy_claim_pending" && session.revoked_at === null) revokeSession(app.db, session.id, nowIso);
      clearSessionCookie(reply, app.config);
      return;
    }
    request.auth = { userId: session.user_id, sessionId: session.id, sessionKind: session.kind, expiresAt: session.expires_at };
  });

  app.decorate("requireAnySession", async (request: FastifyRequest, reply: FastifyReply) => {
    await app.optionalAuth(request, reply);
    if (reply.sent) return;
    if (!request.auth) {
      await reply.code(401).send(jsonError("UNAUTHORIZED", "An active session is required"));
      return;
    }
    await requireExpectedSessionContext(request, reply);
    if (!reply.sent) refreshNormalSession(app, request, reply);
  });

  app.decorate("requireAuth", async (request: FastifyRequest, reply: FastifyReply) => {
    await app.optionalAuth(request, reply);
    if (reply.sent) return;
    if (!request.auth || request.auth.sessionKind !== "normal") {
      await reply.code(401).send(jsonError("UNAUTHORIZED", "A normal session is required"));
      return;
    }
    await requireExpectedSessionContext(request, reply);
    if (!reply.sent) refreshNormalSession(app, request, reply);
  });

  app.decorate("requireWorkspaceMember", async (request: FastifyRequest, reply: FastifyReply) => {
    await app.requireAuth(request, reply);
    if (reply.sent || !request.auth) return;
    const workspaceId = (request.params as { workspaceId?: unknown }).workspaceId;
    if (typeof workspaceId !== "string") {
      await reply.code(404).send(jsonError("WORKSPACE_NOT_FOUND", "Workspace not found"));
      return;
    }
    const membership = app.db.prepare(`SELECT w.owner_user_id FROM memberships m
      JOIN workspaces w ON w.id=m.workspace_id WHERE m.workspace_id=? AND m.user_id=?`)
      .get(workspaceId, request.auth.userId) as { owner_user_id: string } | undefined;
    if (!membership) {
      await reply.code(404).send(jsonError("WORKSPACE_NOT_FOUND", "Workspace not found"));
      return;
    }
    request.workspaceAccess = { workspaceId, owner: membership.owner_user_id === request.auth.userId };
  });
}

export function currentCookieToken(request: FastifyRequest, config: AppConfig): string | undefined {
  return readCookie(request, config);
}
