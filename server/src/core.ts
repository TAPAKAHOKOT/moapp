import { createHash, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { clearSessionCookie, createSession, hashSecret, refreshNormalSession, requireExpectedSessionContext, revokeSession, revokeSessionInTransaction, setSessionCookie } from "./auth.js";
import type { LegacyClaimRow, WorkspaceRow } from "./types.js";
import { authenticatedSession, createUser, guestSession, getUserProfile, listDeviceSessions, listWorkspaceSummaries, normalizeDisplayName } from "./users.js";
import { isUuid, jsonError } from "./validation.js";
import { createWorkspace, getWorkspaceSummary, listParticipants, normalizeWorkspaceName, revokeWorkspaceInvitations } from "./workspaces.js";

const scrypt = promisify(scryptCallback);
const UPGRADE_ERROR = jsonError("UPGRADE_REQUIRED", "This sign-in method is no longer available; update the app");

function fail(reply: FastifyReply, status: number, code: string, message: string) {
  return reply.code(status).send(jsonError(code, message));
}

async function requireMutation(request: FastifyRequest, reply: FastifyReply, app: FastifyInstance, bodyless = false): Promise<boolean> {
  if (request.headers.origin !== app.config.appOrigin) {
    await fail(reply, 403, "FORBIDDEN", "Request origin is not allowed");
    return false;
  }
  if (bodyless) {
    if (request.body !== undefined || (request.headers["content-length"] !== undefined && request.headers["content-length"] !== "0")) {
      await fail(reply, 400, "REQUEST_ERROR", "This request must not contain a body");
      return false;
    }
    return true;
  }
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers["content-type"] ?? "")) {
    await fail(reply, 415, "REQUEST_ERROR", "Content-Type must be application/json");
    return false;
  }
  return true;
}

function isAttemptToken(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value);
}

async function pinMatches(pin: string, configuredPin: string, sessionSecret: string): Promise<boolean> {
  const salt = createHash("sha256").update(sessionSecret).digest().subarray(0, 16);
  const [expected, actual] = await Promise.all([
    scrypt(configuredPin.normalize("NFKC"), salt, 64) as Promise<Buffer>,
    scrypt(pin.normalize("NFKC"), salt, 64) as Promise<Buffer>
  ]);
  return timingSafeEqual(expected, actual);
}

const displayNameBody = {
  type: "object",
  required: ["displayName"],
  additionalProperties: false,
  properties: { displayName: { type: "string", minLength: 1, maxLength: 240 } }
} as const;

const workspaceIdParams = {
  type: "object",
  required: ["workspaceId"],
  additionalProperties: false,
  properties: { workspaceId: { type: "string", format: "uuid" } }
} as const;

function ownerInsideTransaction(app: FastifyInstance, workspaceId: string, userId: string): WorkspaceRow | undefined {
  const workspace = app.db.prepare("SELECT * FROM workspaces WHERE id=?").get(workspaceId) as WorkspaceRow | undefined;
  if (!workspace || workspace.owner_user_id !== userId) return undefined;
  return workspace;
}

export async function registerCoreRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/session", { preHandler: app.optionalAuth }, async (request, reply) => {
    refreshNormalSession(app, request, reply);
    return request.auth ? authenticatedSession(app.db, request.auth) : guestSession(app.db);
  });

  app.delete("/api/session", { preHandler: app.optionalAuth }, async (request, reply) => {
    if (!await requireMutation(request, reply, app, true)) return;
    if (request.auth) {
      await requireExpectedSessionContext(request, reply);
      if (reply.sent) return;
      revokeSession(app.db, request.auth.sessionId);
    }
    clearSessionCookie(reply, app.config);
    return reply.code(204).send();
  });

  app.post("/api/identity", {
    preHandler: app.optionalAuth,
    config: { rateLimit: { max: 3, timeWindow: "1 hour" } },
    schema: { body: displayNameBody }
  }, async (request, reply) => {
    if (!await requireMutation(request, reply, app)) return;
    if (request.auth) return fail(reply, 409, "ALREADY_AUTHENTICATED", "This browser already has a profile");
    const displayName = normalizeDisplayName((request.body as { displayName: unknown }).displayName);
    if (!displayName) return fail(reply, 400, "INVALID_DISPLAY_NAME", "Display name is invalid");
    const session = app.db.transaction(() => {
      const user = createUser(app.db, displayName);
      return createSession(app.db, app.config, { userId: user.id, userAgent: request.headers["user-agent"] });
    })();
    setSessionCookie(reply, app.config, session);
    return reply.code(201).send(authenticatedSession(app.db, session.principal));
  });

  app.patch("/api/me", { preHandler: app.requireAuth, schema: { body: displayNameBody } }, async (request, reply) => {
    if (!await requireMutation(request, reply, app) || !request.auth) return;
    const displayName = normalizeDisplayName((request.body as { displayName: unknown }).displayName);
    if (!displayName) return fail(reply, 400, "INVALID_DISPLAY_NAME", "Display name is invalid");
    const now = new Date().toISOString();
    app.db.prepare("UPDATE users SET display_name=?,updated_at=? WHERE id=?").run(displayName, now, request.auth.userId);
    return { user: getUserProfile(app.db, request.auth.userId)! };
  });

  app.get("/api/me/sessions", { preHandler: app.requireAuth }, async (request) => ({
    sessions: listDeviceSessions(app.db, request.auth!.userId, request.auth!.sessionId)
  }));

  app.delete("/api/me/sessions/:sessionId", {
    preHandler: app.requireAuth,
    schema: { params: { type: "object", required: ["sessionId"], additionalProperties: false, properties: { sessionId: { type: "string", format: "uuid" } } } }
  }, async (request, reply) => {
    if (!await requireMutation(request, reply, app, true) || !request.auth) return;
    const { sessionId } = request.params as { sessionId: string };
    if (sessionId === request.auth.sessionId) return fail(reply, 409, "USE_LOGOUT", "Use logout to revoke the current session");
    const owned = app.db.prepare("SELECT 1 FROM sessions WHERE id=? AND user_id=?").get(sessionId, request.auth.userId);
    if (!owned) return fail(reply, 404, "NOT_FOUND", "Session not found");
    revokeSession(app.db, sessionId);
    return reply.code(204).send();
  });

  app.get("/api/workspaces", { preHandler: app.requireAuth }, async (request) => ({
    workspaces: listWorkspaceSummaries(app.db, request.auth!.userId)
  }));

  app.post("/api/workspaces", {
    preHandler: app.requireAuth,
    config: { rateLimit: { max: 5, timeWindow: "1 hour", keyGenerator: (request: FastifyRequest) => request.auth?.userId ?? request.ip } },
    schema: { body: { type: "object", required: ["id", "name"], additionalProperties: false, properties: { id: { type: "string", format: "uuid" }, name: { type: "string", minLength: 1, maxLength: 320 } } } }
  }, async (request, reply) => {
    if (!await requireMutation(request, reply, app) || !request.auth) return;
    const body = request.body as { id: unknown; name: unknown };
    if (!isUuid(body.id)) return fail(reply, 400, "REQUEST_ERROR", "Workspace ID must be a UUID");
    const name = normalizeWorkspaceName(body.name);
    if (!name) return fail(reply, 400, "INVALID_WORKSPACE_NAME", "Workspace name is invalid");
    const result = createWorkspace(app.db, { id: body.id, name, ownerUserId: request.auth.userId });
    if ("conflict" in result) return fail(reply, 409, "IDEMPOTENCY_CONFLICT", "Workspace ID was already used with different data");
    return reply.code(result.replayed ? 200 : 201).send({ workspace: result.workspace });
  });

  app.patch("/api/workspaces/:workspaceId", {
    preHandler: app.requireWorkspaceMember,
    schema: { params: workspaceIdParams, body: { type: "object", required: ["name", "version"], additionalProperties: false, properties: { name: { type: "string", minLength: 1, maxLength: 320 }, version: { type: "integer", minimum: 1 } } } }
  }, async (request, reply) => {
    if (!await requireMutation(request, reply, app) || !request.auth) return;
    if (!request.workspaceAccess?.owner) return fail(reply, 403, "FORBIDDEN", "Only the workspace owner can rename it");
    const workspaceId = request.workspaceAccess.workspaceId;
    const body = request.body as { name: unknown; version: number };
    const name = normalizeWorkspaceName(body.name);
    if (!name) return fail(reply, 400, "INVALID_WORKSPACE_NAME", "Workspace name is invalid");
    const outcome = app.db.transaction(() => {
      const workspace = ownerInsideTransaction(app, workspaceId, request.auth!.userId);
      if (!workspace) return "forbidden" as const;
      const now = new Date().toISOString();
      const updated = app.db.prepare("UPDATE workspaces SET name=?,version=version+1,updated_at=? WHERE id=? AND owner_user_id=? AND version=?")
        .run(name, now, workspaceId, request.auth!.userId, body.version);
      return updated.changes === 0 ? "version" as const : getWorkspaceSummary(app.db, workspaceId, request.auth!.userId)!;
    })();
    if (outcome === "forbidden") return fail(reply, 403, "FORBIDDEN", "Only the workspace owner can rename it");
    if (outcome === "version") return fail(reply, 409, "VERSION_CONFLICT", "Workspace version has changed");
    return { workspace: outcome };
  });

  app.get("/api/workspaces/:workspaceId/members", { preHandler: app.requireWorkspaceMember, schema: { params: workspaceIdParams } }, async (request) => ({
    members: listParticipants(app.db, request.workspaceAccess!.workspaceId, request.auth!.userId)
  }));

  app.delete("/api/workspaces/:workspaceId/members/me", { preHandler: app.requireWorkspaceMember, schema: { params: workspaceIdParams } }, async (request, reply) => {
    if (!await requireMutation(request, reply, app, true) || !request.auth) return;
    const workspaceId = request.workspaceAccess!.workspaceId;
    const outcome = app.db.transaction(() => {
      const workspace = app.db.prepare("SELECT owner_user_id FROM workspaces WHERE id=?").get(workspaceId) as { owner_user_id: string } | undefined;
      if (!workspace) return "missing" as const;
      if (workspace.owner_user_id === request.auth!.userId) return "owner" as const;
      const removed = app.db.prepare("DELETE FROM memberships WHERE workspace_id=? AND user_id=?").run(workspaceId, request.auth!.userId);
      return removed.changes === 0 ? "missing" as const : "removed" as const;
    })();
    if (outcome === "owner") return fail(reply, 409, "OWNER_CANNOT_LEAVE", "Transfer ownership before leaving");
    if (outcome === "missing") return fail(reply, 404, "WORKSPACE_NOT_FOUND", "Workspace not found");
    return reply.code(204).send();
  });

  app.delete("/api/workspaces/:workspaceId/members/:userId", {
    preHandler: app.requireWorkspaceMember,
    schema: { params: { type: "object", required: ["workspaceId", "userId"], additionalProperties: false, properties: { workspaceId: { type: "string", format: "uuid" }, userId: { type: "string", format: "uuid" } } } }
  }, async (request, reply) => {
    if (!await requireMutation(request, reply, app, true) || !request.auth) return;
    if (!request.workspaceAccess?.owner) return fail(reply, 403, "FORBIDDEN", "Only the workspace owner can remove members");
    const workspaceId = request.workspaceAccess.workspaceId;
    const { userId } = request.params as { userId: string };
    const outcome = app.db.transaction(() => {
      const workspace = ownerInsideTransaction(app, workspaceId, request.auth!.userId);
      if (!workspace) return "forbidden" as const;
      if (workspace.owner_user_id === userId) return "owner" as const;
      const removed = app.db.prepare("DELETE FROM memberships WHERE workspace_id=? AND user_id=?").run(workspaceId, userId);
      if (removed.changes === 0) return "missing" as const;
      revokeWorkspaceInvitations(app.db, workspaceId, new Date().toISOString(), userId);
      return "removed" as const;
    })();
    if (outcome === "forbidden") return fail(reply, 403, "FORBIDDEN", "Only the workspace owner can remove members");
    if (outcome === "owner") return fail(reply, 409, "OWNER_CANNOT_LEAVE", "Transfer ownership before removing the owner");
    if (outcome === "missing") return fail(reply, 404, "NOT_FOUND", "Member not found");
    return reply.code(204).send();
  });

  app.post("/api/workspaces/:workspaceId/transfer-ownership", {
    preHandler: app.requireWorkspaceMember,
    schema: { params: workspaceIdParams, body: { type: "object", required: ["userId", "version"], additionalProperties: false, properties: { userId: { type: "string", format: "uuid" }, version: { type: "integer", minimum: 1 } } } }
  }, async (request, reply) => {
    if (!await requireMutation(request, reply, app) || !request.auth) return;
    if (!request.workspaceAccess?.owner) return fail(reply, 403, "FORBIDDEN", "Only the workspace owner can transfer ownership");
    const workspaceId = request.workspaceAccess.workspaceId;
    const { userId, version } = request.body as { userId: string; version: number };
    const outcome = app.db.transaction(() => {
      const workspace = ownerInsideTransaction(app, workspaceId, request.auth!.userId);
      if (!workspace) return "forbidden" as const;
      const target = app.db.prepare("SELECT 1 FROM memberships WHERE workspace_id=? AND user_id=?").get(workspaceId, userId);
      if (!target) return "missing" as const;
      const now = new Date().toISOString();
      const updated = app.db.prepare(`UPDATE workspaces SET owner_user_id=?,version=version+1,updated_at=?
        WHERE id=? AND owner_user_id=? AND version=?`).run(userId, now, workspaceId, request.auth!.userId, version);
      if (updated.changes === 0) return "version" as const;
      revokeWorkspaceInvitations(app.db, workspaceId, now);
      return getWorkspaceSummary(app.db, workspaceId, request.auth!.userId)!;
    })();
    if (outcome === "forbidden") return fail(reply, 403, "FORBIDDEN", "Only the workspace owner can transfer ownership");
    if (outcome === "missing") return fail(reply, 404, "NOT_FOUND", "Target member not found");
    if (outcome === "version") return fail(reply, 409, "VERSION_CONFLICT", "Workspace version has changed");
    return { workspace: outcome };
  });

  app.post("/api/legacy-claim", {
    preHandler: app.optionalAuth,
    config: { rateLimit: { max: 5, timeWindow: "1 minute" } },
    schema: { body: { type: "object", required: ["pin", "displayName", "attemptToken"], additionalProperties: false, properties: {
      pin: { type: "string", minLength: 1, maxLength: 128 }, displayName: { type: "string", minLength: 1, maxLength: 240 }, attemptToken: { type: "string", minLength: 43, maxLength: 43 }
    } } }
  }, async (request, reply) => {
    if (!await requireMutation(request, reply, app)) return;
    const body = request.body as { pin: string; displayName: unknown; attemptToken: unknown };
    const displayName = normalizeDisplayName(body.displayName);
    if (!displayName || !isAttemptToken(body.attemptToken)) return fail(reply, 400, "REQUEST_ERROR", "Claim input is invalid");
    if (request.auth?.sessionKind === "normal") return fail(reply, 409, "ALREADY_AUTHENTICATED", "This browser already has a profile");
    if (request.auth) {
      await requireExpectedSessionContext(request, reply);
      if (reply.sent) return;
    }
    const availableClaim = app.db.prepare("SELECT state FROM legacy_claims LIMIT 1").get() as { state: LegacyClaimRow["state"] } | undefined;
    if (!availableClaim || availableClaim.state === "closed") return reply.code(410).send(UPGRADE_ERROR);
    if (!app.config.pin || !await pinMatches(body.pin, app.config.pin, app.config.sessionSecret)) {
      return fail(reply, 401, "INVALID_PIN", "Invalid PIN");
    }
    const now = new Date();
    const nowIso = now.toISOString();
    const attemptHash = hashSecret(body.attemptToken);
    if (request.auth) {
      const claim = app.db.prepare("SELECT * FROM legacy_claims LIMIT 1").get() as LegacyClaimRow | undefined;
      if (claim?.state === "claimed_pending" && claim.pending_session_id === request.auth.sessionId
        && claim.attempt_hash === attemptHash && claim.pending_expires_at! > nowIso) {
        return reply.send(authenticatedSession(app.db, request.auth, nowIso));
      }
      return fail(reply, 409, "CLAIM_IN_PROGRESS", "Another legacy claim is in progress");
    }
    const result = app.db.transaction(() => {
      let claim = app.db.prepare("SELECT * FROM legacy_claims LIMIT 1").get() as LegacyClaimRow | undefined;
      if (!claim || claim.state === "closed") return { error: "closed" as const };
      if (claim.state === "claimed_pending" && claim.pending_expires_at! <= nowIso) {
        revokeSessionInTransaction(app.db, claim.pending_session_id!, nowIso);
        app.db.prepare(`UPDATE legacy_claims SET state='open',attempt_hash=NULL,pending_session_id=NULL,pending_expires_at=NULL,updated_at=?
          WHERE workspace_id=? AND state='claimed_pending' AND pending_expires_at<=?`).run(nowIso, claim.workspace_id, nowIso);
        claim = app.db.prepare("SELECT * FROM legacy_claims WHERE workspace_id=?").get(claim.workspace_id) as LegacyClaimRow;
      }
      if (claim.state === "claimed_pending" && claim.attempt_hash !== attemptHash) return { error: "in_progress" as const };
      if (claim.state === "claimed_pending") revokeSessionInTransaction(app.db, claim.pending_session_id!, nowIso);
      const expires = new Date(now.getTime() + app.config.access.legacyClaimTtlMinutes * 60_000);
      const session = createSession(app.db, app.config, {
        userId: claim.owner_user_id,
        kind: "legacy_claim_pending",
        userAgent: request.headers["user-agent"],
        now,
        expiresAt: expires
      });
      app.db.prepare("UPDATE users SET display_name=?,updated_at=? WHERE id=?").run(displayName, nowIso, claim.owner_user_id);
      app.db.prepare(`UPDATE legacy_claims SET state='claimed_pending',attempt_hash=?,pending_session_id=?,pending_expires_at=?,updated_at=? WHERE workspace_id=?`)
        .run(attemptHash, session.id, session.expiresAt, nowIso, claim.workspace_id);
      return { session };
    })();
    if ("error" in result) {
      if (result.error === "in_progress") return fail(reply, 409, "CLAIM_IN_PROGRESS", "Another legacy claim is in progress");
      return reply.code(410).send(UPGRADE_ERROR);
    }
    setSessionCookie(reply, app.config, result.session);
    return reply.send(authenticatedSession(app.db, result.session.principal, nowIso));
  });

  app.post("/api/session", async (_request, reply) => reply.code(410).send(UPGRADE_ERROR));
  app.post("/api/auth/login", async (_request, reply) => reply.code(410).send(UPGRADE_ERROR));
  app.get("/api/auth/session", async (_request, reply) => reply.code(410).send(UPGRADE_ERROR));
  app.post("/api/auth/logout", async (_request, reply) => reply.code(410).send(UPGRADE_ERROR));
}
