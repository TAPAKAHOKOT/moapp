import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  createSession,
  requireExpectedSessionContext,
  revokeSessionInTransaction,
  setSessionCookie
} from "../auth.js";
import { noStore, requireMutationOrigin } from "../tenant-domain-guard.js";
import type { LegacyClaimRow, SessionRow, UserRow, WorkspaceRow } from "../types.js";
import { authenticatedSession } from "../users.js";
import { jsonError } from "../validation.js";
import { getWorkspaceSummary } from "../workspaces.js";
import { capabilityUrl, generateSecret, secretHash, sendLinkInvalid } from "./token-helpers.js";

type AccessKind = "invitation" | "device_link" | "recovery_rotation";

type AccessTokenRow = {
  id: string;
  kind: AccessKind;
  token_hash: string;
  workspace_id: string | null;
  target_user_id: string | null;
  created_by_user_id: string | null;
  created_by_session_id: string | null;
  replacement_token_hash: string | null;
  expected_generation: number | null;
  revoke_sessions: 0 | 1;
  accept_attempt_hash: string | null;
  accepted_session_id: string | null;
  created_at: string;
  expires_at: string;
  consumed_at: string | null;
  revoked_at: string | null;
};

type RateBucket = { expiresAt: number; count: number };

const MAX_RATE_BUCKETS = 10_000;

const tokenBody = {
  type: "object",
  required: ["token"],
  additionalProperties: false,
  properties: { token: { type: "string", minLength: 43, maxLength: 43, pattern: "^[A-Za-z0-9_-]+$" } }
} as const;

const completionBody = {
  type: "object",
  required: ["completionToken"],
  additionalProperties: false,
  properties: { completionToken: { type: "string", minLength: 43, maxLength: 43, pattern: "^[A-Za-z0-9_-]+$" } }
} as const;

const emptyBody = { type: "object", additionalProperties: false, maxProperties: 0 } as const;

function fail(reply: FastifyReply, status: number, code: string, message: string): FastifyReply {
  return reply.code(status).send(jsonError(code, message));
}

async function requireJsonMutation(app: FastifyInstance, request: FastifyRequest, reply: FastifyReply): Promise<boolean> {
  await requireMutationOrigin(app, request, reply);
  return !reply.sent;
}

async function requireBodylessMutation(app: FastifyInstance, request: FastifyRequest, reply: FastifyReply): Promise<boolean> {
  await requireMutationOrigin(app, request, reply, false);
  if (reply.sent) return false;
  if (request.body !== undefined || (request.headers["content-length"] !== undefined && request.headers["content-length"] !== "0")) {
    await fail(reply, 400, "REQUEST_ERROR", "This request must not contain a body");
    return false;
  }
  return true;
}

async function requireGuestCapableContext(request: FastifyRequest, reply: FastifyReply): Promise<boolean> {
  if (!request.auth) return true;
  if (request.auth.sessionKind !== "normal") {
    await fail(reply, 401, "UNAUTHORIZED", "This session is restricted to recovery setup");
    return false;
  }
  await requireExpectedSessionContext(request, reply);
  return !reply.sent;
}

function activeAccessBySecret(app: FastifyInstance, kind: AccessKind, token: string, now: string): AccessTokenRow | undefined {
  return app.db.prepare(`SELECT * FROM access_tokens
    WHERE kind=? AND token_hash=? AND revoked_at IS NULL AND expires_at>?`).get(kind, secretHash(token), now) as AccessTokenRow | undefined;
}

function rateLimit(
  buckets: Map<string, RateBucket>,
  key: string,
  max: number,
  windowMs: number,
  reply: FastifyReply,
  now = Date.now()
): boolean {
  if (buckets.size >= MAX_RATE_BUCKETS && !buckets.has(key)) {
    for (const [bucketKey, value] of buckets) {
      if (value.expiresAt <= now) buckets.delete(bucketKey);
    }
    if (buckets.size >= MAX_RATE_BUCKETS) {
      const oldest = buckets.keys().next().value as string | undefined;
      if (oldest !== undefined) buckets.delete(oldest);
    }
  }
  const current = buckets.get(key);
  const bucket = !current || current.expiresAt <= now
    ? { expiresAt: now + windowMs, count: 0 }
    : current;
  if (bucket.count >= max) {
    const retryAfter = Math.max(1, Math.ceil((bucket.expiresAt - now) / 1000));
    void reply.header("Retry-After", String(retryAfter));
    void fail(reply, 429, "RATE_LIMITED", "Too many requests; try again later");
    return false;
  }
  bucket.count += 1;
  buckets.set(key, bucket);
  return true;
}

function recoveryPrepareResponse(app: FastifyInstance, recoverySecret: string, completionToken: string, expiresAt: string, nextGeneration: number) {
  return {
    recoveryUrl: capabilityUrl(app.config.appOrigin, "recover", recoverySecret),
    completionToken,
    expiresAt,
    nextGeneration
  };
}

function revokeAllOldAccess(app: FastifyInstance, userId: string, now: string): void {
  const sessions = app.db.prepare("SELECT id FROM sessions WHERE user_id=? AND revoked_at IS NULL").all(userId) as Array<{ id: string }>;
  for (const session of sessions) revokeSessionInTransaction(app.db, session.id, now);
  app.db.prepare(`UPDATE access_tokens SET revoked_at=?
    WHERE kind='device_link' AND target_user_id=? AND revoked_at IS NULL AND expires_at>?`).run(now, userId, now);
  app.db.prepare(`UPDATE access_tokens SET revoked_at=?
    WHERE kind='invitation' AND created_by_user_id=? AND revoked_at IS NULL AND consumed_at IS NULL AND expires_at>?`).run(now, userId, now);
}

function restrictedClaimIsCurrent(app: FastifyInstance, userId: string, sessionId: string, now: string): LegacyClaimRow | undefined {
  return app.db.prepare(`SELECT * FROM legacy_claims
    WHERE owner_user_id=? AND state='claimed_pending' AND pending_session_id=? AND pending_expires_at>?`)
    .get(userId, sessionId, now) as LegacyClaimRow | undefined;
}

export async function registerAccessRoutes(app: FastifyInstance): Promise<void> {
  const buckets = new Map<string, RateBucket>();
  const quietNoStore = { onSend: noStore, logLevel: "silent" as const };
  const jsonMutation = (request: FastifyRequest, reply: FastifyReply) => requireMutationOrigin(app, request, reply);
  const bodylessMutation = (request: FastifyRequest, reply: FastifyReply) => requireMutationOrigin(app, request, reply, false);

  app.get("/api/workspaces/:workspaceId/invitations", {
    ...quietNoStore,
    preHandler: app.requireWorkspaceMember,
    schema: { params: { type: "object", required: ["workspaceId"], additionalProperties: false, properties: { workspaceId: { type: "string", format: "uuid" } } } }
  }, async (request, reply) => {
    if (!request.workspaceAccess?.owner) return fail(reply, 403, "FORBIDDEN", "Only the workspace owner can view invitations");
    const now = new Date().toISOString();
    const invitations = app.db.prepare(`SELECT id,workspace_id,expires_at,created_at FROM access_tokens
      WHERE kind='invitation' AND workspace_id=? AND consumed_at IS NULL AND revoked_at IS NULL AND expires_at>?
      ORDER BY created_at DESC,id`).all(request.workspaceAccess.workspaceId, now) as Array<{
        id: string; workspace_id: string; expires_at: string; created_at: string;
      }>;
    return { invitations: invitations.map((row) => ({ id: row.id, workspaceId: row.workspace_id, expiresAt: row.expires_at, createdAt: row.created_at })) };
  });

  app.post("/api/workspaces/:workspaceId/invitations", {
    ...quietNoStore,
    preHandler: app.requireWorkspaceMember,
    preValidation: jsonMutation,
    schema: {
      params: { type: "object", required: ["workspaceId"], additionalProperties: false, properties: { workspaceId: { type: "string", format: "uuid" } } },
      body: { type: "object", additionalProperties: false, properties: { ttlHours: { type: "integer" } } }
    }
  }, async (request, reply) => {
    if (!await requireJsonMutation(app, request, reply) || !request.auth) return;
    if (!request.workspaceAccess?.owner) return fail(reply, 403, "FORBIDDEN", "Only the workspace owner can create invitations");
    const workspaceId = request.workspaceAccess.workspaceId;
    if (!rateLimit(buckets, `invite:${workspaceId}`, app.config.access.invitationRateLimitPerHour, 3_600_000, reply)) return;
    const ttlHours = (request.body as { ttlHours?: number }).ttlHours ?? app.config.access.invitationTtlHours;
    if (!Number.isSafeInteger(ttlHours) || ttlHours < app.config.access.invitationMinTtlHours || ttlHours > app.config.access.invitationMaxTtlHours) {
      return fail(reply, 400, "REQUEST_ERROR", "Invitation TTL is outside the allowed range");
    }
    const token = generateSecret();
    const now = new Date();
    const createdAt = now.toISOString();
    const expiresAt = new Date(now.getTime() + ttlHours * 3_600_000).toISOString();
    const id = randomUUID();
    const outcome = app.db.transaction(() => {
      const session = app.db.prepare(`SELECT 1 FROM sessions WHERE id=? AND user_id=? AND kind='normal'
        AND revoked_at IS NULL AND expires_at>?`).get(request.auth!.sessionId, request.auth!.userId, createdAt);
      if (!session) return "unauthorized" as const;
      const workspace = app.db.prepare("SELECT owner_user_id FROM workspaces WHERE id=?").get(workspaceId) as Pick<WorkspaceRow, "owner_user_id"> | undefined;
      if (!workspace || workspace.owner_user_id !== request.auth!.userId) return "forbidden" as const;
      const count = app.db.prepare(`SELECT count(*) AS count FROM access_tokens
        WHERE kind='invitation' AND workspace_id=? AND consumed_at IS NULL AND revoked_at IS NULL AND expires_at>?`)
        .get(workspaceId, createdAt) as { count: number };
      if (count.count >= app.config.access.maxActiveInvitations) return "limit" as const;
      app.db.prepare(`INSERT INTO access_tokens
        (id,kind,token_hash,workspace_id,target_user_id,created_by_user_id,created_by_session_id,
         replacement_token_hash,expected_generation,revoke_sessions,accept_attempt_hash,accepted_session_id,
         created_at,expires_at,consumed_at,revoked_at)
        VALUES (?,'invitation',?,?,NULL,?,?,NULL,NULL,0,NULL,NULL,?,?,NULL,NULL)`)
        .run(id, secretHash(token), workspaceId, request.auth!.userId, request.auth!.sessionId, createdAt, expiresAt);
      return "created" as const;
    })();
    if (outcome === "unauthorized") return fail(reply, 401, "UNAUTHORIZED", "The authorizing session is no longer active");
    if (outcome === "forbidden") return fail(reply, 403, "FORBIDDEN", "Only the workspace owner can create invitations");
    if (outcome === "limit") {
      void reply.header("Retry-After", "3600");
      return fail(reply, 429, "RATE_LIMITED", "Too many active invitations");
    }
    return reply.code(201).send({
      invitation: { id, workspaceId, expiresAt, createdAt },
      url: capabilityUrl(app.config.appOrigin, "join", token)
    });
  });

  app.delete("/api/workspaces/:workspaceId/invitations/:invitationId", {
    ...quietNoStore,
    preHandler: app.requireWorkspaceMember,
    preValidation: bodylessMutation,
    schema: { params: { type: "object", required: ["workspaceId", "invitationId"], additionalProperties: false, properties: {
      workspaceId: { type: "string", format: "uuid" }, invitationId: { type: "string", format: "uuid" }
    } } }
  }, async (request, reply) => {
    if (!await requireBodylessMutation(app, request, reply) || !request.auth) return;
    if (!request.workspaceAccess?.owner) return fail(reply, 403, "FORBIDDEN", "Only the workspace owner can revoke invitations");
    const { workspaceId, invitationId } = request.params as { workspaceId: string; invitationId: string };
    const now = new Date().toISOString();
    const outcome = app.db.transaction(() => {
      const workspace = app.db.prepare("SELECT owner_user_id FROM workspaces WHERE id=?").get(workspaceId) as Pick<WorkspaceRow, "owner_user_id"> | undefined;
      if (!workspace || workspace.owner_user_id !== request.auth!.userId) return "forbidden" as const;
      const revoked = app.db.prepare(`UPDATE access_tokens SET revoked_at=?
        WHERE id=? AND kind='invitation' AND workspace_id=? AND consumed_at IS NULL AND revoked_at IS NULL`).run(now, invitationId, workspaceId);
      return revoked.changes === 0 ? "missing" as const : "revoked" as const;
    })();
    if (outcome === "forbidden") return fail(reply, 403, "FORBIDDEN", "Only the workspace owner can revoke invitations");
    if (outcome === "missing") return fail(reply, 404, "NOT_FOUND", "Invitation not found");
    return reply.code(204).send();
  });

  app.post("/api/access/invitations/preview", {
    ...quietNoStore,
    preHandler: app.optionalAuth,
    preValidation: jsonMutation,
    schema: { body: tokenBody }
  }, async (request, reply) => {
    if (!await requireJsonMutation(app, request, reply)) return;
    if (request.auth?.sessionKind === "legacy_claim_pending") {
      return fail(reply, 401, "UNAUTHORIZED", "This session is restricted to recovery setup");
    }
    if (!rateLimit(buckets, `access:${request.ip}`, app.config.access.accessPreviewRateLimitPerMinute, 60_000, reply)) return;
    const now = new Date().toISOString();
    const row = activeAccessBySecret(app, "invitation", (request.body as { token: string }).token, now);
    if (!row || row.consumed_at !== null || row.workspace_id === null) return sendLinkInvalid(reply);
    const workspace = app.db.prepare("SELECT id,name FROM workspaces WHERE id=?").get(row.workspace_id) as { id: string; name: string } | undefined;
    if (!workspace) return sendLinkInvalid(reply);
    return { kind: "invitation" as const, workspace, expiresAt: row.expires_at };
  });

  app.post("/api/access/invitations/accept", {
    ...quietNoStore,
    preHandler: app.requireAuth,
    preValidation: jsonMutation,
    schema: { body: tokenBody }
  }, async (request, reply) => {
    if (!await requireJsonMutation(app, request, reply) || !request.auth) return;
    if (!rateLimit(buckets, `access:${request.ip}`, app.config.access.accessPreviewRateLimitPerMinute, 60_000, reply)) return;
    const tokenHash = secretHash((request.body as { token: string }).token);
    const now = new Date().toISOString();
    const outcome = app.db.transaction(() => {
      const row = app.db.prepare(`SELECT * FROM access_tokens WHERE kind='invitation' AND token_hash=?
        AND consumed_at IS NULL AND revoked_at IS NULL AND expires_at>?`).get(tokenHash, now) as AccessTokenRow | undefined;
      if (!row?.workspace_id) return { kind: "invalid" as const };
      const member = app.db.prepare("SELECT 1 FROM memberships WHERE workspace_id=? AND user_id=?").get(row.workspace_id, request.auth!.userId);
      if (member) return { kind: "member" as const };
      const consumed = app.db.prepare(`UPDATE access_tokens SET consumed_at=? WHERE id=? AND kind='invitation'
        AND consumed_at IS NULL AND revoked_at IS NULL AND expires_at>?`).run(now, row.id, now);
      if (consumed.changes === 0) return { kind: "invalid" as const };
      app.db.prepare(`INSERT INTO memberships(workspace_id,user_id,joined_at,added_by_user_id)
        VALUES (?,?,?,?)`).run(row.workspace_id, request.auth!.userId, now, row.created_by_user_id);
      return { kind: "accepted" as const, workspaceId: row.workspace_id };
    })();
    if (outcome.kind === "invalid") return sendLinkInvalid(reply);
    if (outcome.kind === "member") return fail(reply, 409, "ALREADY_MEMBER", "This profile is already a workspace member");
    return { workspace: getWorkspaceSummary(app.db, outcome.workspaceId, request.auth.userId)! };
  });

  app.post("/api/me/device-links", {
    ...quietNoStore,
    preHandler: app.requireAuth,
    preValidation: jsonMutation,
    schema: { body: emptyBody }
  }, async (request, reply) => {
    if (!await requireJsonMutation(app, request, reply) || !request.auth) return;
    if (!rateLimit(buckets, `device:${request.auth.userId}`, app.config.access.deviceLinkRateLimitPerHour, 3_600_000, reply)) return;
    const token = generateSecret();
    const now = new Date();
    const createdAt = now.toISOString();
    const expiresAt = new Date(now.getTime() + app.config.access.deviceLinkTtlMinutes * 60_000).toISOString();
    const id = randomUUID();
    app.db.transaction(() => {
      const session = app.db.prepare(`SELECT 1 FROM sessions WHERE id=? AND user_id=? AND kind='normal'
        AND revoked_at IS NULL AND expires_at>?`).get(request.auth!.sessionId, request.auth!.userId, createdAt);
      if (!session) throw new Error("Authenticated device-link creator became inactive");
      app.db.prepare(`INSERT INTO access_tokens
        (id,kind,token_hash,workspace_id,target_user_id,created_by_user_id,created_by_session_id,
         replacement_token_hash,expected_generation,revoke_sessions,accept_attempt_hash,accepted_session_id,
         created_at,expires_at,consumed_at,revoked_at)
        VALUES (?,'device_link',?,NULL,?,?,?,NULL,NULL,0,NULL,NULL,?,?,NULL,NULL)`)
        .run(id, secretHash(token), request.auth!.userId, request.auth!.userId, request.auth!.sessionId, createdAt, expiresAt);
    })();
    return reply.code(201).send({
      deviceLink: { id, expiresAt },
      url: capabilityUrl(app.config.appOrigin, "device", token)
    });
  });

  app.post("/api/access/device-links/preview", {
    ...quietNoStore,
    preHandler: app.optionalAuth,
    preValidation: jsonMutation,
    schema: { body: tokenBody }
  }, async (request, reply) => {
    if (!await requireJsonMutation(app, request, reply)) return;
    if (request.auth?.sessionKind === "legacy_claim_pending") {
      return fail(reply, 401, "UNAUTHORIZED", "This session is restricted to recovery setup");
    }
    if (!rateLimit(buckets, `access:${request.ip}`, app.config.access.accessPreviewRateLimitPerMinute, 60_000, reply)) return;
    const now = new Date().toISOString();
    const row = activeAccessBySecret(app, "device_link", (request.body as { token: string }).token, now);
    if (!row || row.consumed_at !== null || !row.target_user_id) return sendLinkInvalid(reply);
    const user = app.db.prepare("SELECT display_name FROM users WHERE id=?").get(row.target_user_id) as { display_name: string } | undefined;
    if (!user) return sendLinkInvalid(reply);
    return { kind: "device" as const, targetUserId: row.target_user_id, displayName: user.display_name, expiresAt: row.expires_at };
  });

  app.post("/api/access/device-links/accept", {
    ...quietNoStore,
    preHandler: app.optionalAuth,
    preValidation: jsonMutation,
    schema: { body: { type: "object", required: ["token", "attemptToken"], additionalProperties: false, properties: {
      token: tokenBody.properties.token,
      attemptToken: { type: "string", minLength: 43, maxLength: 43, pattern: "^[A-Za-z0-9_-]+$" }
    } } }
  }, async (request, reply) => {
    if (!await requireJsonMutation(app, request, reply) || !await requireGuestCapableContext(request, reply)) return;
    if (!rateLimit(buckets, `access:${request.ip}`, app.config.access.accessPreviewRateLimitPerMinute, 60_000, reply)) return;
    const body = request.body as { token: string; attemptToken: string };
    const linkHash = secretHash(body.token);
    const attemptHash = secretHash(body.attemptToken);
    const nowDate = new Date();
    const now = nowDate.toISOString();
    const outcome = app.db.transaction(() => {
      const row = app.db.prepare(`SELECT * FROM access_tokens WHERE kind='device_link' AND token_hash=?
        AND revoked_at IS NULL AND expires_at>?`).get(linkHash, now) as AccessTokenRow | undefined;
      if (!row?.target_user_id) return { kind: "invalid" as const };

      if (row.consumed_at === null) {
        if (request.auth?.userId !== undefined && request.auth.userId !== row.target_user_id) return { kind: "identity" as const };
        if (request.auth?.userId === row.target_user_id) return { kind: "connected" as const };
        const session = createSession(app.db, app.config, { userId: row.target_user_id, userAgent: request.headers["user-agent"], now: nowDate });
        const consumed = app.db.prepare(`UPDATE access_tokens SET consumed_at=?,accept_attempt_hash=?,accepted_session_id=?
          WHERE id=? AND kind='device_link' AND consumed_at IS NULL AND revoked_at IS NULL AND expires_at>?`)
          .run(now, attemptHash, session.id, row.id, now);
        if (consumed.changes === 0) throw new Error("Device link changed during atomic consume");
        return { kind: "accepted" as const, session };
      }

      if (row.accept_attempt_hash !== attemptHash || !row.accepted_session_id) return { kind: "invalid" as const };
      const accepted = app.db.prepare("SELECT * FROM sessions WHERE id=? AND user_id=?").get(row.accepted_session_id, row.target_user_id) as SessionRow | undefined;
      if (!accepted || accepted.revoked_at !== null || accepted.expires_at <= now) return { kind: "invalid" as const };
      if (request.auth && request.auth.userId !== row.target_user_id) return { kind: "identity" as const };
      if (request.auth && request.auth.sessionId !== accepted.id) return { kind: "connected" as const };

      app.db.prepare("UPDATE sessions SET revoked_at=? WHERE id=? AND revoked_at IS NULL").run(now, accepted.id);
      app.db.prepare(`UPDATE access_tokens SET revoked_at=? WHERE revoked_at IS NULL AND expires_at>? AND id<>? AND (
        (created_by_session_id=? AND kind='device_link')
        OR (created_by_session_id=? AND kind='invitation' AND consumed_at IS NULL)
      )`).run(now, now, row.id, accepted.id, accepted.id);
      const session = createSession(app.db, app.config, { userId: row.target_user_id, userAgent: request.headers["user-agent"], now: nowDate });
      const replaced = app.db.prepare(`UPDATE access_tokens SET accepted_session_id=?
        WHERE id=? AND kind='device_link' AND token_hash=? AND accepted_session_id=?
        AND accept_attempt_hash=? AND consumed_at IS NOT NULL AND revoked_at IS NULL AND expires_at>?`)
        .run(session.id, row.id, linkHash, accepted.id, attemptHash, now);
      if (replaced.changes === 0) throw new Error("Device retry changed during atomic replacement");
      return { kind: "accepted" as const, session };
    })();
    if (outcome.kind === "invalid") return sendLinkInvalid(reply);
    if (outcome.kind === "identity") return fail(reply, 409, "IDENTITY_CONFLICT", "This link belongs to a different profile");
    if (outcome.kind === "connected") return fail(reply, 409, "ALREADY_CONNECTED", "This profile is already connected in this browser");
    setSessionCookie(reply, app.config, outcome.session);
    return reply.send(authenticatedSession(app.db, outcome.session.principal, now));
  });

  app.post("/api/me/recovery/rotation/prepare", {
    ...quietNoStore,
    preHandler: app.requireAnySession,
    preValidation: jsonMutation,
    schema: { body: emptyBody }
  }, async (request, reply) => {
    if (!await requireJsonMutation(app, request, reply) || !request.auth) return;
    if (!rateLimit(buckets, `manual:${request.auth.userId}`, app.config.access.manualRecoveryRateLimitPerHour, 3_600_000, reply)) return;
    const recoverySecret = generateSecret();
    const completionToken = generateSecret();
    const nowDate = new Date();
    const now = nowDate.toISOString();
    const expiresAt = new Date(nowDate.getTime() + app.config.access.recoveryRotationTtlMinutes * 60_000).toISOString();
    const result = app.db.transaction(() => {
      const user = app.db.prepare("SELECT * FROM users WHERE id=?").get(request.auth!.userId) as UserRow | undefined;
      if (!user) return { kind: "unauthorized" as const };
      const activeSession = app.db.prepare(`SELECT 1 FROM sessions WHERE id=? AND user_id=? AND kind=?
        AND revoked_at IS NULL AND expires_at>?`).get(request.auth!.sessionId, user.id, request.auth!.sessionKind, now);
      if (!activeSession) return { kind: "unauthorized" as const };
      if (request.auth!.sessionKind === "legacy_claim_pending") {
        if (user.recovery_token_hash !== null || !restrictedClaimIsCurrent(app, user.id, request.auth!.sessionId, now)) {
          return { kind: "unauthorized" as const };
        }
      }
      const id = randomUUID();
      app.db.prepare(`INSERT INTO access_tokens
        (id,kind,token_hash,workspace_id,target_user_id,created_by_user_id,created_by_session_id,
         replacement_token_hash,expected_generation,revoke_sessions,accept_attempt_hash,accepted_session_id,
         created_at,expires_at,consumed_at,revoked_at)
        VALUES (?,'recovery_rotation',?,NULL,?,?,?,?,?,0,NULL,NULL,?,?,NULL,NULL)`)
        .run(id, secretHash(completionToken), user.id, user.id, request.auth!.sessionId,
          secretHash(recoverySecret), user.recovery_generation, now, expiresAt);
      return { kind: "prepared" as const, nextGeneration: user.recovery_generation + 1 };
    })();
    if (result.kind === "unauthorized") return fail(reply, 401, "UNAUTHORIZED", "This session cannot configure recovery");
    return recoveryPrepareResponse(app, recoverySecret, completionToken, expiresAt, result.nextGeneration);
  });

  app.post("/api/me/recovery/rotation/complete", {
    ...quietNoStore,
    preHandler: app.requireAnySession,
    preValidation: jsonMutation,
    schema: { body: completionBody }
  }, async (request, reply) => {
    if (!await requireJsonMutation(app, request, reply) || !request.auth) return;
    const nowDate = new Date();
    const now = nowDate.toISOString();
    const completionHash = secretHash((request.body as { completionToken: string }).completionToken);
    const outcome = app.db.transaction(() => {
      const activeSession = app.db.prepare(`SELECT 1 FROM sessions WHERE id=? AND user_id=? AND kind=?
        AND revoked_at IS NULL AND expires_at>?`).get(
        request.auth!.sessionId, request.auth!.userId, request.auth!.sessionKind, now
      );
      if (!activeSession) return { kind: "unauthorized" as const };
      const row = app.db.prepare(`SELECT * FROM access_tokens WHERE kind='recovery_rotation' AND revoke_sessions=0
        AND token_hash=? AND target_user_id=? AND created_by_user_id=? AND created_by_session_id=?
        AND consumed_at IS NULL AND revoked_at IS NULL AND expires_at>?`)
        .get(completionHash, request.auth!.userId, request.auth!.userId, request.auth!.sessionId, now) as AccessTokenRow | undefined;
      if (!row || row.replacement_token_hash === null || row.expected_generation === null) return { kind: "invalid" as const };
      const restricted = request.auth!.sessionKind === "legacy_claim_pending";
      if (restricted && !restrictedClaimIsCurrent(app, request.auth!.userId, request.auth!.sessionId, now)) return { kind: "invalid" as const };
      const updated = app.db.prepare(`UPDATE users SET recovery_token_hash=?,recovery_generation=recovery_generation+1,updated_at=?
        WHERE id=? AND recovery_generation=?`).run(row.replacement_token_hash, now, row.target_user_id, row.expected_generation);
      if (updated.changes === 0) return { kind: "stale" as const };
      app.db.prepare("UPDATE access_tokens SET consumed_at=? WHERE id=? AND consumed_at IS NULL AND revoked_at IS NULL AND expires_at>?")
        .run(now, row.id, now);
      if (!restricted) return { kind: "completed" as const };

      const closed = app.db.prepare(`UPDATE legacy_claims SET state='closed',attempt_hash=NULL,pending_session_id=NULL,
        pending_expires_at=NULL,updated_at=? WHERE owner_user_id=? AND state='claimed_pending'
        AND pending_session_id=? AND pending_expires_at>?`).run(now, request.auth!.userId, request.auth!.sessionId, now);
      if (closed.changes === 0) throw new Error("Legacy recovery claim changed during completion");
      revokeAllOldAccess(app, request.auth!.userId, now);
      const session = createSession(app.db, app.config, { userId: request.auth!.userId, userAgent: request.headers["user-agent"], now: nowDate });
      return { kind: "legacy" as const, session };
    })();
    if (outcome.kind === "unauthorized") return fail(reply, 401, "UNAUTHORIZED", "The authorizing session is no longer active");
    if (outcome.kind === "invalid") return sendLinkInvalid(reply);
    if (outcome.kind === "stale") return fail(reply, 409, "ROTATION_STALE", "Another recovery rotation has already completed");
    if (outcome.kind === "legacy") {
      setSessionCookie(reply, app.config, outcome.session);
      return reply.send(authenticatedSession(app.db, outcome.session.principal, now));
    }
    return reply.send(authenticatedSession(app.db, request.auth, now));
  });

  app.post("/api/access/recovery/preview", {
    ...quietNoStore,
    preHandler: app.optionalAuth,
    preValidation: jsonMutation,
    schema: { body: tokenBody }
  }, async (request, reply) => {
    if (!await requireJsonMutation(app, request, reply)) return;
    if (request.auth?.sessionKind === "legacy_claim_pending") {
      return fail(reply, 401, "UNAUTHORIZED", "This session is restricted to recovery setup");
    }
    if (!rateLimit(buckets, `access:${request.ip}`, app.config.access.accessPreviewRateLimitPerMinute, 60_000, reply)) return;
    const user = app.db.prepare("SELECT * FROM users WHERE recovery_token_hash=?").get(secretHash((request.body as { token: string }).token)) as UserRow | undefined;
    if (!user) return sendLinkInvalid(reply);
    if (request.auth && request.auth.userId !== user.id) return fail(reply, 409, "IDENTITY_CONFLICT", "This recovery link belongs to a different profile");
    return { kind: "recovery" as const, targetUserId: user.id, displayName: user.display_name };
  });

  app.post("/api/access/recovery/prepare", {
    ...quietNoStore,
    preHandler: app.optionalAuth,
    preValidation: jsonMutation,
    schema: { body: tokenBody }
  }, async (request, reply) => {
    if (!await requireJsonMutation(app, request, reply) || !await requireGuestCapableContext(request, reply)) return;
    if (!rateLimit(buckets, `recovery:${request.ip}`, app.config.access.recoveryPrepareRateLimitPerFifteenMinutes, 15 * 60_000, reply)) return;
    const sourceHash = secretHash((request.body as { token: string }).token);
    const initial = app.db.prepare("SELECT * FROM users WHERE recovery_token_hash=?").get(sourceHash) as UserRow | undefined;
    if (!initial) return sendLinkInvalid(reply);
    if (request.auth && request.auth.userId !== initial.id) return fail(reply, 409, "IDENTITY_CONFLICT", "This recovery link belongs to a different profile");
    const recoverySecret = generateSecret();
    const completionToken = generateSecret();
    const nowDate = new Date();
    const now = nowDate.toISOString();
    const expiresAt = new Date(nowDate.getTime() + app.config.access.recoveryRotationTtlMinutes * 60_000).toISOString();
    const result = app.db.transaction(() => {
      const user = app.db.prepare("SELECT * FROM users WHERE id=? AND recovery_token_hash=?").get(initial.id, sourceHash) as UserRow | undefined;
      if (!user) return undefined;
      app.db.prepare(`INSERT INTO access_tokens
        (id,kind,token_hash,workspace_id,target_user_id,created_by_user_id,created_by_session_id,
         replacement_token_hash,expected_generation,revoke_sessions,accept_attempt_hash,accepted_session_id,
         created_at,expires_at,consumed_at,revoked_at)
        VALUES (?,'recovery_rotation',?,NULL,?,NULL,NULL,?,?,1,NULL,NULL,?,?,NULL,NULL)`)
        .run(randomUUID(), secretHash(completionToken), user.id, secretHash(recoverySecret), user.recovery_generation, now, expiresAt);
      return user.recovery_generation + 1;
    })();
    if (result === undefined) return sendLinkInvalid(reply);
    return recoveryPrepareResponse(app, recoverySecret, completionToken, expiresAt, result);
  });

  app.post("/api/access/recovery/complete", {
    ...quietNoStore,
    preHandler: app.optionalAuth,
    preValidation: jsonMutation,
    schema: { body: completionBody }
  }, async (request, reply) => {
    if (!await requireJsonMutation(app, request, reply) || !await requireGuestCapableContext(request, reply)) return;
    if (!rateLimit(buckets, `access:${request.ip}`, app.config.access.accessPreviewRateLimitPerMinute, 60_000, reply)) return;
    const completionHash = secretHash((request.body as { completionToken: string }).completionToken);
    const nowDate = new Date();
    const now = nowDate.toISOString();
    const initial = app.db.prepare(`SELECT * FROM access_tokens WHERE kind='recovery_rotation' AND revoke_sessions=1
      AND token_hash=? AND created_by_user_id IS NULL AND created_by_session_id IS NULL
      AND consumed_at IS NULL AND revoked_at IS NULL AND expires_at>?`).get(completionHash, now) as AccessTokenRow | undefined;
    if (!initial?.target_user_id) return sendLinkInvalid(reply);
    if (request.auth && request.auth.userId !== initial.target_user_id) return fail(reply, 409, "IDENTITY_CONFLICT", "This recovery belongs to a different profile");
    const outcome = app.db.transaction(() => {
      const row = app.db.prepare(`SELECT * FROM access_tokens WHERE id=? AND kind='recovery_rotation' AND revoke_sessions=1
        AND token_hash=? AND target_user_id=? AND created_by_user_id IS NULL AND created_by_session_id IS NULL
        AND consumed_at IS NULL AND revoked_at IS NULL AND expires_at>?`).get(initial.id, completionHash, initial.target_user_id, now) as AccessTokenRow | undefined;
      if (!row || row.target_user_id === null || row.replacement_token_hash === null || row.expected_generation === null) return { kind: "invalid" as const };
      const updated = app.db.prepare(`UPDATE users SET recovery_token_hash=?,recovery_generation=recovery_generation+1,updated_at=?
        WHERE id=? AND recovery_generation=?`).run(row.replacement_token_hash, now, row.target_user_id, row.expected_generation);
      if (updated.changes === 0) return { kind: "stale" as const };
      const consumed = app.db.prepare(`UPDATE access_tokens SET consumed_at=? WHERE id=? AND kind='recovery_rotation'
        AND revoke_sessions=1 AND consumed_at IS NULL AND revoked_at IS NULL AND expires_at>?`).run(now, row.id, now);
      if (consumed.changes === 0) throw new Error("Recovery completion changed during atomic consume");
      revokeAllOldAccess(app, row.target_user_id, now);
      const session = createSession(app.db, app.config, { userId: row.target_user_id, userAgent: request.headers["user-agent"], now: nowDate });
      return { kind: "completed" as const, session };
    })();
    if (outcome.kind === "invalid") return sendLinkInvalid(reply);
    if (outcome.kind === "stale") return fail(reply, 409, "ROTATION_STALE", "Another recovery rotation has already completed");
    setSessionCookie(reply, app.config, outcome.session);
    return reply.send(authenticatedSession(app.db, outcome.session.principal, now));
  });
}

export { cleanupExpiredAccessRows } from "./token-helpers.js";
