import type { Database } from "better-sqlite3";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { BYBIT_CARD_MOD, bybitCardState, forgetBybitCardKeys } from "./bybit-card.js";
import { TBANK_MOD } from "./tbank-statement.js";
import { hasWorkspaceMembership, noStore, requireMutationOrigin, sendWorkspaceNotFound, workspaceContext } from "./tenant-domain-guard.js";
import { jsonError } from "./validation.js";

/*
 * Моды — интеграции, которые пространство добавляет по желанию: карта Bybit и выписка Т‑Банка.
 * Каталог — список ниже, добавленные моды помнит `workspace_mods`. Пространство общее, поэтому добавить
 * и убрать мод может любой участник. Очередь разбора — не часть мода: убранный мод оставляет в ней
 * неразобранное, его разбирают или убирают сами люди. Названия и описания живут в клиенте, рядом с остальными текстами.
 */
type ModDefinition = {
  id: string;
  /** Что добавленный мод рассказывает о себе в списке: у Bybit — состояние ключа. */
  state?: (app: FastifyInstance, workspaceId: string) => Record<string, unknown>;
  /** Мод убирают из пространства: он забывает свои ключи, операции в очереди остаются. */
  onRemove?: (db: Database, workspaceId: string) => void;
  /** Участник ушёл или его удалили: мод забывает то, что этот человек подключил сам. */
  onMemberLeft?: (db: Database, workspaceId: string, userId: string) => void;
};

const MOD_CATALOG: readonly ModDefinition[] = [
  {
    id: BYBIT_CARD_MOD,
    state: bybitCardState,
    onRemove: (db, workspaceId) => { forgetBybitCardKeys(db, workspaceId); },
    onMemberLeft: (db, workspaceId, userId) => { forgetBybitCardKeys(db, workspaceId, userId); }
  },
  { id: TBANK_MOD }
];

type ModRow = { mod_id: string; added_at: string };

/* Каталог целиком: у добавленного мода — когда его добавили и его состояние, у остальных — только `added: false`. */
function listMods(app: FastifyInstance, workspaceId: string) {
  const rows = app.db.prepare("SELECT mod_id,added_at FROM workspace_mods WHERE workspace_id=?").all(workspaceId) as ModRow[];
  const added = new Map(rows.map((row) => [row.mod_id, row.added_at]));
  return MOD_CATALOG.map((mod) => {
    const addedAt = added.get(mod.id);
    if (addedAt === undefined) return { id: mod.id, added: false as const, addedAt: null };
    return { id: mod.id, added: true as const, addedAt, ...(mod.state ? { state: mod.state(app, workspaceId) } : {}) };
  });
}

/* Вызывается в транзакции, которая убирает участника из пространства. */
export function forgetMemberInMods(db: Database, workspaceId: string, userId: string): void {
  for (const mod of MOD_CATALOG) mod.onMemberLeft?.(db, workspaceId, userId);
}

function fail(reply: FastifyReply, status: number, code: string, message: string) {
  return reply.code(status).send(jsonError(code, message));
}

export async function registerModRoutes(app: FastifyInstance): Promise<void> {
  const mutation = (request: FastifyRequest, reply: FastifyReply) => requireMutationOrigin(app, request, reply);
  const prefix = "/api/workspaces/:workspaceId/mods";
  const catalogMod = (request: FastifyRequest) => MOD_CATALOG.find((mod) => mod.id === (request.params as { modId?: string }).modId);

  app.get(prefix, { preHandler: app.requireWorkspaceMember, onSend: noStore }, async (request) => ({
    mods: listMods(app, workspaceContext(request).workspaceId)
  }));

  /* Добавить мод можно и повторно: ответ тот же, дата добавления не меняется. */
  app.put(`${prefix}/:modId`, { preHandler: [app.requireWorkspaceMember, mutation], onSend: noStore }, async (request, reply) => {
    const { workspaceId, userId } = workspaceContext(request);
    const mod = catalogMod(request);
    if (!mod) return fail(reply, 404, "MOD_NOT_FOUND", "There is no such mod");
    const added = app.db.transaction(() => {
      if (!hasWorkspaceMembership(app, workspaceId, userId)) return false;
      app.db.prepare(`INSERT INTO workspace_mods(workspace_id,mod_id,added_by_user_id,added_at) VALUES (?,?,?,?)
        ON CONFLICT(workspace_id,mod_id) DO NOTHING`).run(workspaceId, mod.id, userId, new Date().toISOString());
      return true;
    })();
    if (!added) return sendWorkspaceNotFound(reply);
    return { mods: listMods(app, workspaceId) };
  });

  /* Убрать мод тоже можно повторно. Ключи мода забываются, операции в очереди разбора остаются. */
  app.delete(`${prefix}/:modId`, { preHandler: [app.requireWorkspaceMember, mutation], onSend: noStore }, async (request, reply) => {
    const { workspaceId, userId } = workspaceContext(request);
    const mod = catalogMod(request);
    if (!mod) return fail(reply, 404, "MOD_NOT_FOUND", "There is no such mod");
    const removed = app.db.transaction(() => {
      if (!hasWorkspaceMembership(app, workspaceId, userId)) return false;
      const deleted = app.db.prepare("DELETE FROM workspace_mods WHERE workspace_id=? AND mod_id=?").run(workspaceId, mod.id).changes;
      if (deleted) mod.onRemove?.(app.db, workspaceId);
      return true;
    })();
    if (!removed) return sendWorkspaceNotFound(reply);
    return { mods: listMods(app, workspaceId) };
  });
}
