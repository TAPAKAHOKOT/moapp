import { randomUUID } from "node:crypto";
import type { Database } from "better-sqlite3";
import type {
  AuthenticatedSession,
  DeviceSession,
  GuestSession,
  SessionKind,
  UserProfile,
  UserRow,
  WorkspaceSummary
} from "./types.js";

const FORBIDDEN_NAME_CHARACTERS = /[\p{Cc}\p{Cf}]/u;

export function normalizeDisplayName(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.normalize("NFKC").trim();
  const length = Array.from(normalized).length;
  if (length < 1 || length > 60 || FORBIDDEN_NAME_CHARACTERS.test(normalized)) return undefined;
  return normalized;
}

export function createUser(db: Database, displayName: string, now = new Date().toISOString()): UserRow {
  const row: UserRow = {
    id: randomUUID(),
    display_name: displayName,
    recovery_token_hash: null,
    recovery_generation: 0,
    created_at: now,
    updated_at: now
  };
  db.prepare(`INSERT INTO users
    (id,display_name,recovery_token_hash,recovery_generation,created_at,updated_at)
    VALUES (?,?,NULL,0,?,?)`).run(row.id, row.display_name, now, now);
  return row;
}

export function userProfile(row: UserRow): UserProfile {
  return {
    id: row.id,
    displayName: row.display_name,
    recoveryConfigured: row.recovery_token_hash !== null,
    recoveryGeneration: row.recovery_generation
  };
}

export function getUserProfile(db: Database, userId: string): UserProfile | undefined {
  const row = db.prepare("SELECT * FROM users WHERE id=?").get(userId) as UserRow | undefined;
  return row ? userProfile(row) : undefined;
}

export function listWorkspaceSummaries(db: Database, userId: string): WorkspaceSummary[] {
  const rows = db.prepare(`SELECT w.id,w.name,w.owner_user_id,w.version,m.joined_at
    FROM memberships m JOIN workspaces w ON w.id=m.workspace_id
    WHERE m.user_id=? ORDER BY m.joined_at,w.name COLLATE NOCASE,w.id`).all(userId) as Array<{
      id: string;
      name: string;
      owner_user_id: string;
      version: number;
      joined_at: string;
    }>;
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    role: row.owner_user_id === userId ? "owner" : "member",
    version: row.version,
    joinedAt: row.joined_at
  }));
}

export function authenticatedSession(
  db: Database,
  principal: { userId: string; sessionId: string; sessionKind: SessionKind; expiresAt: string },
  serverTime = new Date().toISOString()
): AuthenticatedSession {
  const user = getUserProfile(db, principal.userId);
  if (!user) throw new Error(`Session ${principal.sessionId} references a missing user`);
  const legacy = db.prepare("SELECT workspace_id FROM legacy_claims WHERE owner_user_id=? LIMIT 1").get(principal.userId) as { workspace_id: string } | undefined;
  return {
    authenticated: true,
    user,
    currentSessionId: principal.sessionId,
    currentSessionExpiresAt: principal.expiresAt,
    serverTime,
    restrictedToRecovery: principal.sessionKind === "legacy_claim_pending",
    workspaces: principal.sessionKind === "normal" ? listWorkspaceSummaries(db, principal.userId) : [],
    legacyWorkspaceId: legacy?.workspace_id ?? null
  };
}

export function guestSession(db: Database, serverTime = new Date().toISOString()): GuestSession {
  const claim = db.prepare("SELECT state,pending_expires_at FROM legacy_claims LIMIT 1").get() as {
    state: "open" | "claimed_pending" | "closed";
    pending_expires_at: string | null;
  } | undefined;
  return {
    authenticated: false,
    user: null,
    workspaces: [],
    legacyClaimAvailable: claim?.state === "open" || (claim?.state === "claimed_pending" && claim.pending_expires_at! <= serverTime),
    serverTime
  };
}

export function listDeviceSessions(db: Database, userId: string, currentSessionId: string, now = new Date().toISOString()): DeviceSession[] {
  const rows = db.prepare(`SELECT id,label,created_at,last_seen_at,expires_at FROM sessions
    WHERE user_id=? AND revoked_at IS NULL AND expires_at>? ORDER BY created_at DESC,id`).all(userId, now) as Array<{
      id: string;
      label: string;
      created_at: string;
      last_seen_at: string;
      expires_at: string;
    }>;
  return rows.map((row) => ({
    id: row.id,
    label: row.label,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
    expiresAt: row.expires_at,
    current: row.id === currentSessionId
  }));
}
