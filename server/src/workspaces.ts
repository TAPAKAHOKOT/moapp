import type { Database } from "better-sqlite3";
import { seedWorkspaceCategories } from "./db.js";
import type { Participant, WorkspaceRow, WorkspaceSummary } from "./types.js";

const FORBIDDEN_NAME_CHARACTERS = /[\p{Cc}\p{Cf}]/u;

export function normalizeWorkspaceName(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.normalize("NFKC").trim();
  const length = Array.from(normalized).length;
  if (length < 1 || length > 80 || FORBIDDEN_NAME_CHARACTERS.test(normalized)) return undefined;
  return normalized;
}

export function workspaceSummary(row: WorkspaceRow & { joined_at: string }, userId: string): WorkspaceSummary {
  return {
    id: row.id,
    name: row.name,
    role: row.owner_user_id === userId ? "owner" : "member",
    version: row.version,
    joinedAt: row.joined_at
  };
}

export function getWorkspaceSummary(db: Database, workspaceId: string, userId: string): WorkspaceSummary | undefined {
  const row = db.prepare(`SELECT w.*,m.joined_at FROM workspaces w
    JOIN memberships m ON m.workspace_id=w.id WHERE w.id=? AND m.user_id=?`).get(workspaceId, userId) as (WorkspaceRow & { joined_at: string }) | undefined;
  return row ? workspaceSummary(row, userId) : undefined;
}

export function createWorkspace(
  db: Database,
  input: { id: string; name: string; ownerUserId: string; now?: string }
): { workspace: WorkspaceSummary; replayed: boolean } | { conflict: true } {
  return db.transaction(() => {
    const existing = db.prepare("SELECT * FROM workspaces WHERE id=?").get(input.id) as WorkspaceRow | undefined;
    if (existing) {
      if (existing.owner_user_id !== input.ownerUserId || existing.name !== input.name) return { conflict: true as const };
      const summary = getWorkspaceSummary(db, input.id, input.ownerUserId);
      if (!summary) return { conflict: true as const };
      return { workspace: summary, replayed: true };
    }
    const now = input.now ?? new Date().toISOString();
    db.prepare(`INSERT INTO workspaces(id,name,owner_user_id,version,created_at,updated_at)
      VALUES (?,?,?,1,?,?)`).run(input.id, input.name, input.ownerUserId, now, now);
    db.prepare(`INSERT INTO memberships(workspace_id,user_id,joined_at,added_by_user_id)
      VALUES (?,?,?,NULL)`).run(input.id, input.ownerUserId, now);
    seedWorkspaceCategories(db, input.id);
    return {
      workspace: { id: input.id, name: input.name, role: "owner" as const, version: 1, joinedAt: now },
      replayed: false
    };
  })();
}

export function listParticipants(db: Database, workspaceId: string, currentUserId: string): Participant[] {
  const rows = db.prepare(`SELECT m.user_id,u.display_name,m.joined_at,w.owner_user_id
    FROM memberships m JOIN users u ON u.id=m.user_id JOIN workspaces w ON w.id=m.workspace_id
    WHERE m.workspace_id=? ORDER BY CASE WHEN m.user_id=w.owner_user_id THEN 0 ELSE 1 END,m.joined_at,u.display_name COLLATE NOCASE,m.user_id`)
    .all(workspaceId) as Array<{ user_id: string; display_name: string; joined_at: string; owner_user_id: string }>;
  return rows.map((row) => ({
    userId: row.user_id,
    displayName: row.display_name,
    role: row.user_id === row.owner_user_id ? "owner" : "member",
    joinedAt: row.joined_at,
    isCurrentUser: row.user_id === currentUserId
  }));
}

export function revokeWorkspaceInvitations(db: Database, workspaceId: string, now: string, creatorUserId?: string): void {
  db.prepare(`UPDATE access_tokens SET revoked_at=? WHERE kind='invitation' AND workspace_id=?
    AND revoked_at IS NULL AND consumed_at IS NULL AND expires_at>?
    ${creatorUserId === undefined ? "" : "AND created_by_user_id=?"}`)
    .run(...(creatorUserId === undefined ? [now, workspaceId, now] : [now, workspaceId, now, creatorUserId]));
}
