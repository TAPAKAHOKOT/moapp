import type { FastifyInstance } from "fastify";
import { createExpense, deleteExpense, updateExpense, type ExpenseInput } from "./expenses.js";
import { hasWorkspaceMembership, noStore, rejectsWorkspaceId, requireMutationOrigin, sendWorkspaceNotFound, workspaceContext } from "./tenant-domain-guard.js";
import { isUuid, jsonError } from "./validation.js";

type Operation = {
  operationId: string;
  type: "createExpense" | "updateExpense" | "deleteExpense";
  payload: ExpenseInput & { version?: number };
};

export async function registerSyncRoutes(app: FastifyInstance): Promise<void> {
  app.post("/api/workspaces/:workspaceId/sync", {
    preHandler: [app.requireWorkspaceMember, (request, reply) => requireMutationOrigin(app, request, reply)],
    onSend: noStore,
    bodyLimit: 512 * 1024
  }, async (request, reply) => {
    if (rejectsWorkspaceId(request.body)) return reply.code(400).send(jsonError("VALIDATION", "workspaceId is defined by the route"));
    const { workspaceId, userId } = workspaceContext(request);
    const { operations } = request.body as { operations?: Operation[] };
    if (!Array.isArray(operations) || operations.length > 200) {
      return reply.code(400).send(jsonError("VALIDATION", "operations must be an array of at most 200 items"));
    }
    const outcome = app.db.transaction(() => {
      // This is deliberately the first read in the batch transaction. A removed
      // member cannot receive a replay or apply any later operation.
      if (!hasWorkspaceMembership(app, workspaceId, userId)) return { member: false as const };
      const results = operations.map((operation) => {
        if (!operation || !isUuid(operation.operationId) || !operation.payload
          || rejectsWorkspaceId(operation.payload)
          || !["createExpense", "updateExpense", "deleteExpense"].includes(operation.type)) {
          return {
            operationId: operation?.operationId ?? null,
            status: "error",
            error: { code: "VALIDATION", message: "Invalid operation" }
          };
        }
        const previous = app.db.prepare(`SELECT result_json FROM sync_operations
          WHERE workspace_id=? AND operation_id=?`).get(workspaceId, operation.operationId) as { result_json: string } | undefined;
        if (previous) return { ...JSON.parse(previous.result_json) as Record<string, unknown>, replayed: true };
        let result: Record<string, unknown>;
        if (operation.type === "createExpense") {
          const created = createExpense(app, workspaceId, {
            ...operation.payload,
            currency: operation.payload.currency?.toUpperCase()
          });
          result = "error" in created
            ? {
                operationId: operation.operationId,
                status: created.code === "IDEMPOTENCY_CONFLICT" ? "conflict" : "error",
                error: { code: created.code ?? "VALIDATION", message: created.error },
                ...(created.current ? { current: created.current } : {})
              }
            : {
                operationId: operation.operationId,
                status: created.status === "existing" ? "unchanged" : "applied",
                expense: created.expense
              };
        } else if (!Number.isInteger(operation.payload.version)) {
          result = {
            operationId: operation.operationId,
            status: "error",
            error: { code: "VALIDATION", message: "version is required" }
          };
        } else {
          const changed = operation.type === "updateExpense"
            ? updateExpense(app, workspaceId, operation.payload.id, {
                ...operation.payload,
                currency: operation.payload.currency?.toUpperCase(),
                version: operation.payload.version!
              })
            : deleteExpense(app, workspaceId, operation.payload.id, operation.payload.version!);
          result = changed.error
            ? {
                operationId: operation.operationId,
                status: changed.code === "VERSION_CONFLICT" ? "conflict" : "error",
                error: { code: changed.code, message: changed.error },
                ...(changed.current ? { current: changed.current } : {})
              }
            : { operationId: operation.operationId, status: "applied", expense: changed.expense };
        }
        app.db.prepare(`INSERT INTO sync_operations(workspace_id,operation_id,result_json,created_at)
          VALUES (?,?,?,?)`).run(workspaceId, operation.operationId, JSON.stringify(result), new Date().toISOString());
        return result;
      });
      return { member: true as const, results };
    })();
    if (!outcome.member) return sendWorkspaceNotFound(reply);
    return { workspaceId, results: outcome.results, serverTime: new Date().toISOString() };
  });
}
