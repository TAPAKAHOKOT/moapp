import type { FastifyInstance } from "fastify";
import { createExpense, deleteExpense, updateExpense, type ExpenseInput } from "./expenses.js";
import { isUuid, jsonError } from "./validation.js";

type Operation = {
  operationId: string;
  type: "createExpense" | "updateExpense" | "deleteExpense";
  payload: ExpenseInput & { version?: number };
};

export async function registerSyncRoutes(app: FastifyInstance): Promise<void> {
  app.post("/api/sync", { preHandler: app.requireAuth, bodyLimit: 512 * 1024 }, async (request, reply) => {
    const { operations } = request.body as { operations?: Operation[] };
    if (!Array.isArray(operations) || operations.length > 200) return reply.code(400).send(jsonError("VALIDATION", "operations must be an array of at most 200 items"));
    const process = app.db.transaction(() => operations.map((operation) => {
      if (!operation || !isUuid(operation.operationId) || !operation.payload || !["createExpense", "updateExpense", "deleteExpense"].includes(operation.type))
        return { operationId: operation?.operationId ?? null, status: "error", error: { code: "VALIDATION", message: "Invalid operation" } };
      const previous = app.db.prepare("SELECT result_json FROM sync_operations WHERE operation_id = ?").get(operation.operationId) as { result_json: string } | undefined;
      if (previous) return { ...JSON.parse(previous.result_json), replayed: true };
      let result: Record<string, unknown>;
      if (operation.type === "createExpense") {
        const created = createExpense(app, { ...operation.payload, currency: operation.payload.currency?.toUpperCase() });
        result = "error" in created
          ? { operationId: operation.operationId, status: "error", error: { code: created.code ?? "VALIDATION", message: created.error } }
          : { operationId: operation.operationId, status: created.status === "existing" ? "unchanged" : "applied", expense: created.expense };
      } else if (!Number.isInteger(operation.payload.version)) {
        result = { operationId: operation.operationId, status: "error", error: { code: "VALIDATION", message: "version is required" } };
      } else {
        const changed = operation.type === "updateExpense"
          ? updateExpense(app, operation.payload.id, { ...operation.payload, currency: operation.payload.currency?.toUpperCase(), version: operation.payload.version! })
          : deleteExpense(app, operation.payload.id, operation.payload.version!);
        result = changed.error
          ? { operationId: operation.operationId, status: changed.code === "VERSION_CONFLICT" ? "conflict" : "error", error: { code: changed.code, message: changed.error }, ...(changed.current ? { current: changed.current } : {}) }
          : { operationId: operation.operationId, status: "applied", expense: changed.expense };
      }
      app.db.prepare("INSERT INTO sync_operations(operation_id,result_json,created_at) VALUES (?,?,?)").run(operation.operationId, JSON.stringify(result), new Date().toISOString());
      return result;
    }));
    return { results: process(), serverTime: new Date().toISOString() };
  });
}
