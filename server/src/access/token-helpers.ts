import { randomBytes } from "node:crypto";
import type { Database } from "better-sqlite3";
import type { FastifyReply } from "fastify";
import { hashSecret } from "../auth.js";
import { jsonError } from "../validation.js";

export const LINK_INVALID_MESSAGE = "This link is invalid or no longer available";

export function generateSecret(): string {
  return randomBytes(32).toString("base64url");
}
export function secretHash(secret: string): string {
  return hashSecret(secret);
}

export function capabilityUrl(origin: string, purpose: "join" | "device" | "recover", secret: string): string {
  return `${origin}/#/${purpose}/${secret}`;
}

export function sendLinkInvalid(reply: FastifyReply): FastifyReply {
  return reply.code(410).send(jsonError("LINK_INVALID", LINK_INVALID_MESSAGE));
}

/**
 * Access rows must be removed before session rows because access rows retain
 * the session IDs needed by device-link lost-response retries.
 */
export function cleanupExpiredAccessRows(db: Database, now = new Date().toISOString()): {
  accessRows: number;
  sessions: number;
} {
  return db.transaction(() => {
    const accessRows = db.prepare("DELETE FROM access_tokens WHERE expires_at<=?").run(now).changes;
    const sessions = db.prepare(`DELETE FROM sessions
      WHERE (expires_at<=? OR (revoked_at IS NOT NULL AND revoked_at<=?))
      AND NOT EXISTS (
        SELECT 1 FROM access_tokens a
        WHERE a.created_by_session_id=sessions.id OR a.accepted_session_id=sessions.id
      )
      AND NOT EXISTS (
        SELECT 1 FROM legacy_claims l WHERE l.pending_session_id=sessions.id
      )`).run(now, now).changes;
    return { accessRows, sessions };
  })();
}
