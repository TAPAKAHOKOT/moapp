import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { hasWorkspaceMembership, noStore, rejectsWorkspaceId, requireMutationOrigin, sendWorkspaceNotFound, workspaceContext } from "./tenant-domain-guard.js";
import { isUuid, jsonError } from "./validation.js";

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

export function categoryJson(row: CategoryRow) {
  return {
    id: row.id,
    name: row.name,
    placement: row.placement,
    sortOrder: row.sort_order,
    color: row.color,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    archivedAt: row.archived_at
  };
}

function duplicateError(error: unknown): boolean {
  return String(error).includes("UNIQUE");
}

export async function registerCategoryRoutes(app: FastifyInstance): Promise<void> {
  const prefix = "/api/workspaces/:workspaceId/categories";
  const requireMutation = (request: import("fastify").FastifyRequest, reply: import("fastify").FastifyReply) => requireMutationOrigin(app, request, reply);

  app.get(prefix, { preHandler: app.requireWorkspaceMember, onSend: noStore }, async (request) => {
    const { workspaceId } = workspaceContext(request);
    const query = request.query as { includeArchived?: string };
    const rows = app.db.prepare(`SELECT * FROM categories WHERE workspace_id=?
      ${query.includeArchived === "true" ? "" : "AND archived_at IS NULL"}
      ORDER BY CASE placement WHEN 'main' THEN 0 ELSE 1 END,sort_order,name`)
      .all(workspaceId) as CategoryRow[];
    return { categories: rows.map(categoryJson) };
  });

  app.post(prefix, { preHandler: [app.requireWorkspaceMember, requireMutation], onSend: noStore }, async (request, reply) => {
    if (rejectsWorkspaceId(request.body)) return reply.code(400).send(jsonError("VALIDATION", "workspaceId is defined by the route"));
    const { workspaceId, userId } = workspaceContext(request);
    const body = request.body as Record<string, unknown>;
    const id = body.id === undefined ? randomUUID() : body.id;
    if (!isUuid(id)) return reply.code(400).send(jsonError("VALIDATION", "id must be a UUID"));
    if (typeof body.name !== "string" || !body.name.trim() || body.name.trim().length > 80) {
      return reply.code(400).send(jsonError("VALIDATION", "name must contain 1-80 characters"));
    }
    if (body.placement !== "main" && body.placement !== "additional") {
      return reply.code(400).send(jsonError("VALIDATION", "placement must be main or additional"));
    }
    const sortOrder = Number(body.sortOrder ?? 0);
    if (!Number.isInteger(sortOrder) || sortOrder < 0) {
      return reply.code(400).send(jsonError("VALIDATION", "sortOrder must be a non-negative integer"));
    }
    const color = body.color === undefined || body.color === null ? null : String(body.color);
    if (color !== null && !/^#[0-9a-f]{6}$/i.test(color)) {
      return reply.code(400).send(jsonError("VALIDATION", "color must be #RRGGBB"));
    }
    try {
      const outcome = app.db.transaction(() => {
        if (!hasWorkspaceMembership(app, workspaceId, userId)) return { member: false as const };
        const existing = app.db.prepare("SELECT * FROM categories WHERE workspace_id=? AND id=?")
          .get(workspaceId, id) as CategoryRow | undefined;
        if (existing) {
          const compatible = existing.name === body.name!.toString().trim()
            && existing.placement === body.placement
            && existing.sort_order === sortOrder
            && existing.color === color;
          return { member: true as const, existing, compatible };
        }
        const now = new Date().toISOString();
        app.db.prepare(`INSERT INTO categories
          (workspace_id,id,name,placement,sort_order,color,version,created_at,updated_at)
          VALUES (?,?,?,?,?,?,1,?,?)`)
          .run(workspaceId, id, body.name!.toString().trim(), body.placement, sortOrder, color, now, now);
        const row = app.db.prepare("SELECT * FROM categories WHERE workspace_id=? AND id=?")
          .get(workspaceId, id) as CategoryRow;
        return { member: true as const, created: row };
      })();
      if (!outcome.member) return sendWorkspaceNotFound(reply);
      if ("existing" in outcome) {
        return outcome.compatible
          ? reply.code(200).send(categoryJson(outcome.existing))
          : reply.code(409).send(jsonError("IDEMPOTENCY_CONFLICT", "Category id already exists with different fields", { current: categoryJson(outcome.existing) }));
      }
      return reply.code(201).send(categoryJson(outcome.created));
    } catch (error) {
      if (duplicateError(error)) return reply.code(409).send(jsonError("DUPLICATE", "Category id or name already exists"));
      throw error;
    }
  });

  app.put(`${prefix}/order`, { preHandler: [app.requireWorkspaceMember, requireMutation], onSend: noStore }, async (request, reply) => {
    if (rejectsWorkspaceId(request.body)) return reply.code(400).send(jsonError("VALIDATION", "workspaceId is defined by the route"));
    const { workspaceId, userId } = workspaceContext(request);
    const { ids } = request.body as { ids?: unknown };
    if (!Array.isArray(ids) || ids.some((id) => typeof id !== "string") || new Set(ids).size !== ids.length) {
      return reply.code(400).send(jsonError("VALIDATION", "ids must be a unique string array"));
    }
    const outcome = app.db.transaction(() => {
      if (!hasWorkspaceMembership(app, workspaceId, userId)) return { member: false as const };
      const existing = app.db.prepare(`SELECT id,placement FROM categories
        WHERE workspace_id=? AND archived_at IS NULL`).all(workspaceId) as Array<{ id: string; placement: "main" | "additional" }>;
      if ((ids as string[]).some((id) => !existing.some((row) => row.id === id))) {
        return { member: true as const, validation: "ids contains an unknown or archived category" };
      }
      const selectedPlacements = new Set(existing.filter((row) => (ids as string[]).includes(row.id)).map((row) => row.placement));
      const validFullOrder = existing.length === ids.length;
      const selectedPlacement = [...selectedPlacements][0];
      const validSingleGroup = selectedPlacements.size === 1
        && existing.filter((row) => row.placement === selectedPlacement).length === ids.length;
      if (!validFullOrder && !validSingleGroup) {
        return { member: true as const, validation: "ids must include all active categories or every category in one placement group" };
      }
      const counts = { main: 0, additional: 0 };
      const get = app.db.prepare("SELECT placement FROM categories WHERE workspace_id=? AND id=? AND archived_at IS NULL");
      const set = app.db.prepare(`UPDATE categories SET sort_order=?,version=version+1,updated_at=?
        WHERE workspace_id=? AND id=? AND archived_at IS NULL`);
      const now = new Date().toISOString();
      for (const id of ids as string[]) {
        const { placement } = get.get(workspaceId, id) as { placement: "main" | "additional" };
        set.run(counts[placement]++, now, workspaceId, id);
      }
      const rows = app.db.prepare(`SELECT * FROM categories WHERE workspace_id=? AND archived_at IS NULL
        ORDER BY CASE placement WHEN 'main' THEN 0 ELSE 1 END,sort_order,name`).all(workspaceId) as CategoryRow[];
      return { member: true as const, rows };
    })();
    if (!outcome.member) return sendWorkspaceNotFound(reply);
    if ("validation" in outcome) return reply.code(400).send(jsonError("VALIDATION", outcome.validation));
    return { categories: outcome.rows.map(categoryJson) };
  });

  app.patch(`${prefix}/:id`, { preHandler: [app.requireWorkspaceMember, requireMutation], onSend: noStore }, async (request, reply) => {
    if (rejectsWorkspaceId(request.body)) return reply.code(400).send(jsonError("VALIDATION", "workspaceId is defined by the route"));
    const { workspaceId, userId } = workspaceContext(request);
    const { id } = request.params as { id: string };
    const body = request.body as Record<string, unknown>;
    if (typeof body.version !== "number" || !Number.isInteger(body.version)) {
      return reply.code(400).send(jsonError("VALIDATION", "version is required"));
    }
    try {
      const outcome = app.db.transaction(() => {
        if (!hasWorkspaceMembership(app, workspaceId, userId)) return { member: false as const };
        const current = app.db.prepare("SELECT * FROM categories WHERE workspace_id=? AND id=?")
          .get(workspaceId, id) as CategoryRow | undefined;
        if (!current) return { member: true as const, missing: true as const };
        if (current.version !== body.version) return { member: true as const, conflict: current };
        const name = body.name === undefined ? current.name : typeof body.name === "string" ? body.name.trim() : "";
        const placement = body.placement === undefined ? current.placement : body.placement;
        const sortOrder = body.sortOrder === undefined ? current.sort_order : Number(body.sortOrder);
        const color = body.color === undefined ? current.color : body.color === null ? null : String(body.color);
        if (!name || name.length > 80 || (placement !== "main" && placement !== "additional")
          || !Number.isInteger(sortOrder) || sortOrder < 0 || (color !== null && !/^#[0-9a-f]{6}$/i.test(color))) {
          return { member: true as const, validation: "Invalid category fields" };
        }
        if (body.archivedAt !== undefined && body.archivedAt !== null
          && (typeof body.archivedAt !== "string" || Number.isNaN(Date.parse(body.archivedAt)))) {
          return { member: true as const, validation: "archivedAt must be an ISO timestamp or null" };
        }
        const archivedAt = body.archivedAt !== undefined
          ? body.archivedAt === null ? null : new Date(body.archivedAt as string).toISOString()
          : body.archived === undefined ? current.archived_at : body.archived ? new Date().toISOString() : null;
        app.db.prepare(`UPDATE categories SET name=?,placement=?,sort_order=?,color=?,archived_at=?,
          version=version+1,updated_at=? WHERE workspace_id=? AND id=? AND version=?`)
          .run(name, placement, sortOrder, color, archivedAt, new Date().toISOString(), workspaceId, id, body.version);
        const row = app.db.prepare("SELECT * FROM categories WHERE workspace_id=? AND id=?")
          .get(workspaceId, id) as CategoryRow;
        return { member: true as const, row };
      })();
      if (!outcome.member) return sendWorkspaceNotFound(reply);
      if ("missing" in outcome) return reply.code(404).send(jsonError("NOT_FOUND", "Category not found"));
      if ("conflict" in outcome) return reply.code(409).send(jsonError("VERSION_CONFLICT", "Category was changed", { current: categoryJson(outcome.conflict) }));
      if ("validation" in outcome) return reply.code(400).send(jsonError("VALIDATION", outcome.validation));
      return categoryJson(outcome.row);
    } catch (error) {
      if (duplicateError(error)) return reply.code(409).send(jsonError("DUPLICATE", "Category name already exists"));
      throw error;
    }
  });

  app.delete(`${prefix}/:id`, { preHandler: [app.requireWorkspaceMember, requireMutation], onSend: noStore }, async (request, reply) => {
    if (rejectsWorkspaceId(request.body)) return reply.code(400).send(jsonError("VALIDATION", "workspaceId is defined by the route"));
    const { workspaceId, userId } = workspaceContext(request);
    const { id } = request.params as { id: string };
    const { version } = (request.body ?? {}) as { version?: number };
    if (!Number.isInteger(version)) return reply.code(400).send(jsonError("VALIDATION", "version is required"));
    const outcome = app.db.transaction(() => {
      if (!hasWorkspaceMembership(app, workspaceId, userId)) return { member: false as const };
      const row = app.db.prepare("SELECT * FROM categories WHERE workspace_id=? AND id=?")
        .get(workspaceId, id) as CategoryRow | undefined;
      if (!row) return { member: true as const, missing: true as const };
      if (row.version !== version) return { member: true as const, conflict: row };
      const now = new Date().toISOString();
      app.db.prepare(`UPDATE categories SET archived_at=?,updated_at=?,version=version+1
        WHERE workspace_id=? AND id=? AND version=?`).run(now, now, workspaceId, id, version);
      return { member: true as const, removed: true as const };
    })();
    if (!outcome.member) return sendWorkspaceNotFound(reply);
    if ("missing" in outcome) return reply.code(404).send(jsonError("NOT_FOUND", "Category not found"));
    if ("conflict" in outcome) return reply.code(409).send(jsonError("VERSION_CONFLICT", "Category was changed", { current: categoryJson(outcome.conflict) }));
    return reply.code(204).send();
  });
}
