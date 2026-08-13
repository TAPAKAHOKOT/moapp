import type { Database } from "better-sqlite3";
import type { FastifyReply, FastifyRequest } from "fastify";

export type SessionKind = "normal" | "legacy_claim_pending";

export type AuthPrincipal = {
  userId: string;
  sessionId: string;
  sessionKind: SessionKind;
  expiresAt: string;
};

export type WorkspaceAccess = {
  workspaceId: string;
  owner: boolean;
};

export type AccessConfig = {
  invitationTtlHours: number;
  invitationMinTtlHours: number;
  invitationMaxTtlHours: number;
  maxActiveInvitations: number;
  deviceLinkTtlMinutes: number;
  recoveryRotationTtlMinutes: number;
  legacyClaimTtlMinutes: number;
  accessPreviewRateLimitPerMinute: number;
  invitationRateLimitPerHour: number;
  deviceLinkRateLimitPerHour: number;
  recoveryPrepareRateLimitPerFifteenMinutes: number;
  manualRecoveryRateLimitPerHour: number;
};

export type AppConfig = {
  databasePath: string;
  pin?: string;
  sessionSecret: string;
  sessionTtlDays: number;
  secureCookies: boolean;
  appOrigin: string;
  access: AccessConfig;
  frankfurterUrl: string;
  defaultAnalyticsCurrency: string;
};

declare module "fastify" {
  interface FastifyInstance {
    db: Database;
    config: AppConfig;
    optionalAuth: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    requireAnySession: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    requireAuth: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    requireWorkspaceMember: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }

  interface FastifyRequest {
    auth?: AuthPrincipal;
    workspaceAccess?: WorkspaceAccess;
  }
}

export type UserProfile = {
  id: string;
  displayName: string;
  recoveryConfigured: boolean;
  recoveryGeneration: number;
};

export type WorkspaceSummary = {
  id: string;
  name: string;
  role: "owner" | "member";
  version: number;
  joinedAt: string;
};

export type AuthenticatedSession = {
  authenticated: true;
  user: UserProfile;
  currentSessionId: string;
  currentSessionExpiresAt: string;
  serverTime: string;
  restrictedToRecovery: boolean;
  workspaces: WorkspaceSummary[];
  legacyWorkspaceId: string | null;
};

export type GuestSession = {
  authenticated: false;
  user: null;
  workspaces: [];
  legacyClaimAvailable: boolean;
  serverTime: string;
};

export type Participant = {
  userId: string;
  displayName: string;
  role: "owner" | "member";
  joinedAt: string;
  isCurrentUser: boolean;
};

export type DeviceSession = {
  id: string;
  label: string;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
  current: boolean;
};

export type UserRow = {
  id: string;
  display_name: string;
  recovery_token_hash: string | null;
  recovery_generation: number;
  created_at: string;
  updated_at: string;
};

export type SessionRow = {
  id: string;
  token_hash: string;
  user_id: string;
  kind: SessionKind;
  label: string;
  created_at: string;
  last_seen_at: string;
  expires_at: string;
  revoked_at: string | null;
};

export type WorkspaceRow = {
  id: string;
  name: string;
  owner_user_id: string;
  version: number;
  created_at: string;
  updated_at: string;
};

export type MembershipRow = {
  workspace_id: string;
  user_id: string;
  joined_at: string;
  added_by_user_id: string | null;
};

export type LegacyClaimRow = {
  workspace_id: string;
  owner_user_id: string;
  state: "open" | "claimed_pending" | "closed";
  attempt_hash: string | null;
  pending_session_id: string | null;
  pending_expires_at: string | null;
  updated_at: string;
};

export type ExpenseRow = {
  workspace_id: string;
  id: string;
  amount_minor: number;
  currency: string;
  category_id: string;
  occurred_at: string;
  note: string | null;
  version: number;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
};

export type CategoryRow = {
  workspace_id: string;
  id: string;
  name: string;
  placement: "main" | "additional";
  sort_order: number;
  color: string | null;
  version: number;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
};
