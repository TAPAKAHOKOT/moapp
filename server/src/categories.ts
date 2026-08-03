import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { CategoryRow } from "./types.js";
import { isUuid, jsonError } from "./validation.js";

export function categoryJson(row: CategoryRow) {
  return {
    id: row.id, name: row.name, placement: row.placement, sortOrder: row.sort_order,
    color: row.color, version: row.version, createdAt: row.created_at,
    updatedAt: row.updated_at, archivedAt: row.archived_at
  };
}

export async function registerCategoryRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/categories", { preHandler: app.requireAuth }, async (request) => {
    const query = request.query as { includeArchived?: string };
    const rows = app.db.prepare(`SELECT * FROM categories ${query.includeArchived === "true" ? "" : "WHERE archived_at IS NULL"}
      ORDER BY CASE placement WHEN 'main' THEN 0 ELSE 1 END, sort_order, name`).all() as CategoryRow[];
    return { categories: rows.map(categoryJson) };
  });

  app.post("/api/categories", { preHandler: app.requireAuth }, async (request, reply) => {
    const body = request.body as Record<string, unknown>;
    const id = body.id === undefined ? randomUUID() : body.id;
    if (!isUuid(id)) return reply.code(400).send(jsonError("VALIDATION", "id must be a UUID"));
    if (typeof body.name !== "string" || !body.name.trim() || body.name.trim().length > 80)
      return reply.code(400).send(jsonError("VALIDATION", "name must contain 1-80 characters"));
    if (body.placement !== "main" && body.placement !== "additional")
      return reply.code(400).send(jsonError("VALIDATION", "placement must be main or additional"));
    const sortOrder = Number(body.sortOrder ?? 0);
    if (!Number.isInteger(sortOrder) || sortOrder < 0) return reply.code(400).send(jsonError("VALIDATION", "sortOrder must be a non-negative integer"));
    const color = body.color === undefined || body.color === null ? null : String(body.color);
    if (color !== null && !/^#[0-9a-f]{6}$/i.test(color)) return reply.code(400).send(jsonError("VALIDATION", "color must be #RRGGBB"));
    const existing = app.db.prepare("SELECT * FROM categories WHERE id = ?").get(id) as CategoryRow | undefined;
    if (existing) {
      const compatible = existing.name === body.name.trim()
        && existing.placement === body.placement
        && existing.sort_order === sortOrder
        && existing.color === color;
      return compatible
        ? reply.code(200).send(categoryJson(existing))
        : reply.code(409).send(jsonError("IDEMPOTENCY_CONFLICT", "Category id already exists with different fields", { current: categoryJson(existing) }));
    }
    const now = new Date().toISOString();
    try {
      app.db.prepare(`INSERT INTO categories(id,name,placement,sort_order,color,version,created_at,updated_at)
        VALUES (?,?,?,?,?,1,?,?)`).run(id, body.name.trim(), body.placement, sortOrder, color, now, now);
    } catch (error) {
      if (String(error).includes("UNIQUE")) return reply.code(409).send(jsonError("DUPLICATE", "Category id or name already exists"));
      throw error;
    }
    const row = app.db.prepare("SELECT * FROM categories WHERE id = ?").get(id) as CategoryRow;
    return reply.code(201).send(categoryJson(row));
  });

  app.put("/api/categories/order", { preHandler: app.requireAuth }, async (request, reply) => {
    const { ids } = request.body as { ids?: unknown };
    if (!Array.isArray(ids) || ids.some((id) => typeof id !== "string") || new Set(ids).size !== ids.length)
      return reply.code(400).send(jsonError("VALIDATION", "ids must be a unique string array"));
    const existing = app.db.prepare(`SELECT id,placement FROM categories WHERE archived_at IS NULL`).all() as { id: string; placement: "main" | "additional" }[];
    if ((ids as string[]).some((id) => !existing.some((row) => row.id === id)))
      return reply.code(400).send(jsonError("VALIDATION", "ids contains an unknown or archived category"));
    const selectedPlacements = new Set(existing.filter((row) => (ids as string[]).includes(row.id)).map((row) => row.placement));
    const validFullOrder = existing.length === ids.length;
    const validSingleGroup = selectedPlacements.size === 1 && existing.filter((row) => row.placement === [...selectedPlacements][0]).length === ids.length;
    if (!validFullOrder && !validSingleGroup)
      return reply.code(400).send(jsonError("VALIDATION", "ids must include all active categories or every category in one placement group"));
    const update = app.db.transaction(() => {
      const counts = { main: 0, additional: 0 };
      const get = app.db.prepare("SELECT placement FROM categories WHERE id=?");
      const set = app.db.prepare("UPDATE categories SET sort_order=?,version=version+1,updated_at=? WHERE id=?");
      const now = new Date().toISOString();
      for (const id of ids as string[]) {
        const { placement } = get.get(id) as { placement: "main" | "additional" };
        set.run(counts[placement]++, now, id);
      }
    });
    update();
    const rows = app.db.prepare("SELECT * FROM categories WHERE archived_at IS NULL ORDER BY CASE placement WHEN 'main' THEN 0 ELSE 1 END,sort_order").all() as CategoryRow[];
    return { categories: rows.map(categoryJson) };
  });

  app.patch("/api/categories/:id", { preHandler: app.requireAuth }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = request.body as Record<string, unknown>;
    if (typeof body.version !== "number" || !Number.isInteger(body.version)) return reply.code(400).send(jsonError("VALIDATION", "version is required"));
    const current = app.db.prepare("SELECT * FROM categories WHERE id = ?").get(id) as CategoryRow | undefined;
    if (!current) return reply.code(404).send(jsonError("NOT_FOUND", "Category not found"));
    if (current.version !== body.version) return reply.code(409).send(jsonError("VERSION_CONFLICT", "Category was changed", { current: categoryJson(current) }));
    const name = body.name === undefined ? current.name : typeof body.name === "string" ? body.name.trim() : "";
    const placement = body.placement === undefined ? current.placement : body.placement;
    const sortOrder = body.sortOrder === undefined ? current.sort_order : Number(body.sortOrder);
    const color = body.color === undefined ? current.color : body.color === null ? null : String(body.color);
    if (!name || name.length > 80 || (placement !== "main" && placement !== "additional") || !Number.isInteger(sortOrder) || sortOrder < 0 || (color !== null && !/^#[0-9a-f]{6}$/i.test(color)))
      return reply.code(400).send(jsonError("VALIDATION", "Invalid category fields"));
    if (body.archivedAt !== undefined && body.archivedAt !== null && (typeof body.archivedAt !== "string" || Number.isNaN(Date.parse(body.archivedAt))))
      return reply.code(400).send(jsonError("VALIDATION", "archivedAt must be an ISO timestamp or null"));
    const archivedAt = body.archivedAt !== undefined
      ? body.archivedAt === null ? null : new Date(body.archivedAt as string).toISOString()
      : body.archived === undefined ? current.archived_at : body.archived ? new Date().toISOString() : null;
    try {
      app.db.prepare(`UPDATE categories SET name=?, placement=?, sort_order=?, color=?, archived_at=?, version=version+1, updated_at=? WHERE id=? AND version=?`)
        .run(name, placement, sortOrder, color, archivedAt, new Date().toISOString(), id, body.version);
    } catch (error) {
      if (String(error).includes("UNIQUE")) return reply.code(409).send(jsonError("DUPLICATE", "Category name already exists"));
      throw error;
    }
    return categoryJson(app.db.prepare("SELECT * FROM categories WHERE id = ?").get(id) as CategoryRow);
  });

  app.delete("/api/categories/:id", { preHandler: app.requireAuth }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const { version } = (request.body ?? {}) as { version?: number };
    if (!Number.isInteger(version)) return reply.code(400).send(jsonError("VALIDATION", "version is required"));
    const info = app.db.prepare("UPDATE categories SET archived_at=?, updated_at=?, version=version+1 WHERE id=? AND version=?")
      .run(new Date().toISOString(), new Date().toISOString(), id, version);
    if (!info.changes) {
      const row = app.db.prepare("SELECT * FROM categories WHERE id = ?").get(id) as CategoryRow | undefined;
      return reply.code(row ? 409 : 404).send(jsonError(row ? "VERSION_CONFLICT" : "NOT_FOUND", row ? "Category was changed" : "Category not found", row ? { current: categoryJson(row) } : undefined));
    }
    return reply.code(204).send();
  });
}
