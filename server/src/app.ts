import Fastify, { type FastifyError } from "fastify";
import cookie from "@fastify/cookie";
import rateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { AppConfig, CategoryRow, ExpenseRow } from "./types.js";
import { openDatabase, startBackupHeartbeat } from "./db.js";
import { registerAuth } from "./auth.js";
import { registerCategoryRoutes, categoryJson } from "./categories.js";
import { registerExpenseRoutes, expenseJson } from "./expenses.js";
import { registerRateRoutes, startRateScheduler } from "./rates.js";
import { registerAnalyticsRoutes } from "./analytics.js";
import { registerSyncRoutes } from "./sync.js";
import { jsonError } from "./validation.js";

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

function bootstrapRates(db: import("better-sqlite3").Database) {
  const latest = db.prepare("SELECT MAX(rate_date) date FROM exchange_rates WHERE base_currency='EUR' AND quote_currency='RSD'").get() as { date: string | null };
  const ratesToRsd: Record<string, number> = { RSD: 1 };
  if (!latest.date) return { base: "RSD", date: null, ratesToRsd };
  const rows = db.prepare(`SELECT rate.quote_currency quote,rate.rate
    FROM exchange_rates rate
    JOIN (SELECT quote_currency,MAX(rate_date) rate_date FROM exchange_rates WHERE base_currency='EUR' GROUP BY quote_currency) newest
      ON newest.quote_currency=rate.quote_currency AND newest.rate_date=rate.rate_date
    WHERE rate.base_currency='EUR'`).all() as { quote: string; rate: number }[];
  const rsd = rows.find((row) => row.quote === "RSD")?.rate;
  if (rsd) for (const row of rows) ratesToRsd[row.quote] = rsd / row.rate;
  ratesToRsd.RSD = 1;
  return { base: "RSD", date: latest.date, ratesToRsd };
}

export async function buildApp(config: AppConfig, options: { logger?: boolean; scheduler?: boolean; staticRoot?: string } = {}) {
  const app = Fastify({ logger: options.logger ?? true, trustProxy: true, bodyLimit: 1024 * 1024 });
  const db = openDatabase(config.databasePath);
  const stopBackupHeartbeat = startBackupHeartbeat(db);
  app.decorate("db", db);
  app.decorate("config", config);
  await app.register(cookie, { secret: config.sessionSecret, hook: "onRequest" });
  await app.register(rateLimit, { global: true, max: 300, timeWindow: "1 minute" });
  app.addHook("onClose", async () => {
    stopBackupHeartbeat();
    db.close();
  });

  app.get("/api/health", async () => {
    const database = db.prepare("PRAGMA quick_check").pluck().get();
    return { status: database === "ok" ? "ok" : "degraded", database, time: new Date().toISOString() };
  });
  await registerAuth(app);
  await registerCategoryRoutes(app);
  await registerExpenseRoutes(app);
  await registerRateRoutes(app);
  await registerAnalyticsRoutes(app);
  await registerSyncRoutes(app);

  app.get("/api/bootstrap", { preHandler: app.requireAuth }, async () => {
    const categories = db.prepare("SELECT * FROM categories ORDER BY CASE placement WHEN 'main' THEN 0 ELSE 1 END,sort_order,name").all() as CategoryRow[];
    const expenses = db.prepare("SELECT * FROM expenses WHERE deleted_at IS NULL ORDER BY occurred_at DESC,id DESC").all() as ExpenseRow[];
    return {
      categories: categories.map(categoryJson), expenses: expenses.map(expenseJson),
      currencies: availableCurrencies(), rates: bootstrapRates(db),
      defaultAnalyticsCurrency: config.defaultAnalyticsCurrency, serverTime: new Date().toISOString()
    };
  });

  const clientRoot = options.staticRoot ?? resolve(process.cwd(), "../client/dist");
  if (existsSync(resolve(clientRoot, "index.html"))) {
    await app.register(fastifyStatic, { root: clientRoot, wildcard: false });
  }
  app.setNotFoundHandler(async (request, reply) => {
    if (request.url.startsWith("/api/")) return reply.code(404).send(jsonError("NOT_FOUND", "API route not found"));
    if (existsSync(resolve(clientRoot, "index.html"))) return reply.type("text/html").sendFile("index.html");
    return reply.code(404).send(jsonError("NOT_FOUND", "Not found"));
  });
  app.setErrorHandler((error: FastifyError, request, reply) => {
    request.log.error({ err: error }, "Request failed");
    const status = error.statusCode && error.statusCode >= 400 && error.statusCode < 500 ? error.statusCode : 500;
    return reply.code(status).send(jsonError(status === 500 ? "INTERNAL" : "REQUEST_ERROR", status === 500 ? "Internal server error" : error.message));
  });

  if (options.scheduler !== false) {
    const stop = startRateScheduler(app);
    app.addHook("onClose", async () => stop());
  }
  return app;
}
