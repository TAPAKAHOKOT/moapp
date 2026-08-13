import type { FastifyInstance, FastifyReply, FastifyRequest, onSendHookHandler } from "fastify";
import { jsonError } from "./validation.js";

export type WorkspaceContext = {
  workspaceId: string;
  userId: string;
};

export const noStore: onSendHookHandler = async (_request, reply, payload) => {
  void reply.header("Cache-Control", "private, no-store");
  return payload;
};

export function workspaceContext(request: FastifyRequest): WorkspaceContext {
  const workspaceId = (request.params as { workspaceId?: unknown }).workspaceId;
  const userId = request.auth?.userId;
  if (typeof workspaceId !== "string" || userId === undefined) {
    throw new Error("Workspace route executed without an authenticated workspace context");
  }
  return { workspaceId, userId };
}

export function hasWorkspaceMembership(app: FastifyInstance, workspaceId: string, userId: string): boolean {
  return app.db.prepare("SELECT 1 FROM memberships WHERE workspace_id=? AND user_id=?")
    .get(workspaceId, userId) !== undefined;
}

export function sendWorkspaceNotFound(reply: FastifyReply): FastifyReply {
  return reply.code(404).send(jsonError("WORKSPACE_NOT_FOUND", "Workspace not found"));
}

export function rejectsWorkspaceId(body: unknown): boolean {
  return body !== null && typeof body === "object" && Object.hasOwn(body, "workspaceId");
}

export async function requireMutationOrigin(
  app: FastifyInstance,
  request: FastifyRequest,
  reply: FastifyReply,
  jsonBody = true
): Promise<void> {
  if (request.headers.origin !== app.config.appOrigin) {
    await reply.code(403).send(jsonError("FORBIDDEN", "Request origin is not allowed"));
    return;
  }
  if (jsonBody && !/^application\/json(?:\s*;|$)/i.test(request.headers["content-type"] ?? "")) {
    await reply.code(415).send(jsonError("REQUEST_ERROR", "Content-Type must be application/json"));
  }
}
