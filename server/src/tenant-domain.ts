import type { FastifyInstance } from "fastify";
import { registerAnalyticsRoutes } from "./analytics.js";
import { categoryJson, registerCategoryRoutes, type CategoryRow } from "./categories.js";
import { EXPENSE_SELECT, expenseJson, registerExpenseRoutes, type ExpenseRow } from "./expenses.js";
import { registerTagRoutes, TAGS_ORDERED, tagJson, type TagRow } from "./tags.js";
import { registerRateRoutes } from "./rates.js";
import { registerSyncRoutes } from "./sync.js";
import { noStore, workspaceContext } from "./tenant-domain-guard.js";
import { jsonError } from "./validation.js";
import { getWorkspaceSummary } from "./workspaces.js";

function availableCurrencies() {
  const display = new Intl.DisplayNames(["ru"], { type: "currency" });
  const pinned = ["RSD", "EUR", "USD", "RUB"];
  const codes = [...new Set([...pinned, ...Intl.supportedValuesOf("currency")])];
  return codes.map((code) => {
    const format = new Intl.NumberFormat("ru", { style: "currency", currency: code });
    const options = format.resolvedOptions();
    const symbol = format.formatToParts(0).find((part) => part.type === "currency")?.value ?? code;
    return { code, name: display.of(code) ?? code, symbol, decimals: options.maximumFractionDigits ?? 2 };
  });
}

function bootstrapRates(db: FastifyInstance["db"]) {
  const latest = db.prepare(`SELECT MAX(rate_date) date FROM exchange_rates
    WHERE base_currency='EUR' AND quote_currency='RSD'`).get() as { date: string | null };
  const ratesToRsd: Record<string, number> = { RSD: 1 };
  if (!latest.date) return { base: "RSD", date: null, ratesToRsd };
  const rows = db.prepare(`SELECT rate.quote_currency quote,rate.rate
    FROM exchange_rates rate
    JOIN (SELECT quote_currency,MAX(rate_date) rate_date FROM exchange_rates
      WHERE base_currency='EUR' GROUP BY quote_currency) newest
      ON newest.quote_currency=rate.quote_currency AND newest.rate_date=rate.rate_date
    WHERE rate.base_currency='EUR'`).all() as Array<{ quote: string; rate: number }>;
  const rsd = rows.find((row) => row.quote === "RSD")?.rate;
  if (rsd) for (const row of rows) ratesToRsd[row.quote] = rsd / row.rate;
  ratesToRsd.RSD = 1;
  return { base: "RSD", date: latest.date, ratesToRsd };
}

async function registerBootstrapRoute(app: FastifyInstance): Promise<void> {
  app.get("/api/workspaces/:workspaceId/bootstrap", {
    preHandler: app.requireWorkspaceMember,
    onSend: noStore
  }, async (request, reply) => {
    const { workspaceId, userId } = workspaceContext(request);
    const workspace = getWorkspaceSummary(app.db, workspaceId, userId);
    if (!workspace) return reply.code(404).send(jsonError("WORKSPACE_NOT_FOUND", "Workspace not found"));
    const categories = app.db.prepare(`SELECT * FROM categories WHERE workspace_id=?
      ORDER BY CASE placement WHEN 'main' THEN 0 ELSE 1 END,sort_order,name`).all(workspaceId) as CategoryRow[];
    const expenses = app.db.prepare(`${EXPENSE_SELECT}
      WHERE e.workspace_id=? AND e.deleted_at IS NULL ORDER BY e.occurred_at DESC,e.id DESC`).all(workspaceId) as ExpenseRow[];
    const tags = app.db.prepare(TAGS_ORDERED).all(workspaceId) as TagRow[];
    return {
      workspaceId,
      workspace,
      categories: categories.map(categoryJson),
      tags: tags.map(tagJson),
      expenses: expenses.map(expenseJson),
      currencies: availableCurrencies(),
      rates: bootstrapRates(app.db),
      defaultAnalyticsCurrency: app.config.defaultAnalyticsCurrency,
      serverTime: new Date().toISOString()
    };
  });
}

async function registerUpgradeRequiredRoutes(app: FastifyInstance): Promise<void> {
  const handler = async (_request: unknown, reply: import("fastify").FastifyReply) => reply.code(410)
    .send(jsonError("UPGRADE_REQUIRED", "This API version is no longer supported"));
  const routes: Array<{ method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE"; url: string }> = [
    { method: "GET", url: "/api/bootstrap" },
    { method: "GET", url: "/api/expenses" },
    { method: "GET", url: "/api/expenses/:id" },
    { method: "POST", url: "/api/expenses" },
    { method: "PATCH", url: "/api/expenses/:id" },
    { method: "DELETE", url: "/api/expenses/:id" },
    { method: "GET", url: "/api/categories" },
    { method: "POST", url: "/api/categories" },
    { method: "PATCH", url: "/api/categories/:id" },
    { method: "DELETE", url: "/api/categories/:id" },
    { method: "PUT", url: "/api/categories/order" },
    { method: "GET", url: "/api/analytics" },
    { method: "POST", url: "/api/sync" }
  ];
  for (const route of routes) app.route({ ...route, onSend: noStore, handler });
}

export async function registerTenantDomainRoutes(app: FastifyInstance): Promise<void> {
  await registerBootstrapRoute(app);
  await registerCategoryRoutes(app);
  await registerTagRoutes(app);
  await registerExpenseRoutes(app);
  await registerAnalyticsRoutes(app);
  await registerSyncRoutes(app);
  await registerRateRoutes(app);
  await registerUpgradeRequiredRoutes(app);
}
