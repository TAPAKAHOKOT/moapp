import type { FastifyInstance } from "fastify";
import { noStore, requireMutationOrigin } from "./tenant-domain-guard.js";
import { isCalendarDate, isCurrency, jsonError } from "./validation.js";

type FrankfurterRate = { date: string; base: string; quote: string; rate: number };

function parseRates(data: unknown): FrankfurterRate[] {
  if (Array.isArray(data)) return data.filter((r): r is FrankfurterRate => {
    const x = r as Partial<FrankfurterRate>;
    return typeof x.date === "string" && typeof x.base === "string" && typeof x.quote === "string" && typeof x.rate === "number" && x.rate > 0;
  });
  // Tolerate the v1-shaped response if a compatible mirror is configured.
  const x = data as { date?: string; base?: string; rates?: Record<string, number> };
  if (x.date && x.base && x.rates) return Object.entries(x.rates).map(([quote, rate]) => ({ date: x.date!, base: x.base!, quote, rate }));
  throw new Error("Unexpected Frankfurter response");
}

export async function refreshRates(app: FastifyInstance, from?: string, to?: string): Promise<{ fetched: number; dates: string[] }> {
  const query = new URLSearchParams({ base: "EUR" });
  if (from) query.set("from", from);
  if (to) query.set("to", to);
  const response = await fetch(`${app.config.frankfurterUrl}/rates?${query}`, { signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`Frankfurter returned ${response.status}`);
  const rates = parseRates(await response.json());
  const now = new Date().toISOString();
  const save = app.db.transaction(() => {
    const stmt = app.db.prepare(`INSERT INTO exchange_rates(rate_date,base_currency,quote_currency,rate,fetched_at)
      VALUES (?,?,?,?,?) ON CONFLICT(rate_date,base_currency,quote_currency) DO UPDATE SET rate=excluded.rate,fetched_at=excluded.fetched_at`);
    for (const rate of rates) stmt.run(rate.date, rate.base.toUpperCase(), rate.quote.toUpperCase(), rate.rate, now);
    for (const date of new Set(rates.map((r) => r.date))) stmt.run(date, "EUR", "EUR", 1, now);
  });
  save();
  return { fetched: rates.length, dates: [...new Set(rates.map((r) => r.date))] };
}

type StoredRate = { rate: number; rate_date: string };

function rateFor(app: FastifyInstance, currency: string, date: string): StoredRate | undefined {
  if (currency === "EUR") return { rate: 1, rate_date: date };
  return app.db.prepare(`SELECT rate,rate_date FROM exchange_rates WHERE base_currency='EUR' AND quote_currency=? AND rate_date<=?
    ORDER BY rate_date DESC LIMIT 1`).get(currency, date) as StoredRate | undefined
    ?? app.db.prepare(`SELECT rate,rate_date FROM exchange_rates WHERE base_currency='EUR' AND quote_currency=?
      ORDER BY rate_date DESC LIMIT 1`).get(currency) as StoredRate | undefined;
}

export function convertMajor(app: FastifyInstance, amount: number, source: string, target: string, date: string): { amount: number; rateDate: string } | undefined {
  if (source === target) return { amount, rateDate: date };
  const sourceRate = rateFor(app, source, date);
  const targetRate = rateFor(app, target, date);
  if (!sourceRate || !targetRate) return undefined;
  return { amount: amount / sourceRate.rate * targetRate.rate, rateDate: sourceRate.rate_date < targetRate.rate_date ? sourceRate.rate_date : targetRate.rate_date };
}

export async function ensureRates(app: FastifyInstance, from: string, to: string): Promise<void> {
  const row = app.db.prepare("SELECT MIN(rate_date) min, MAX(rate_date) max FROM exchange_rates WHERE base_currency='EUR'").get() as { min: string | null; max: string | null };
  if (!row.min || !row.max || row.min > from || row.max < to) {
    try { await refreshRates(app, from, to); } catch (error) { app.log.warn({ err: error }, "Could not refresh rates; using cache"); }
  }
}

export async function registerRateRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/rates/status", { preHandler: app.requireAuth, onSend: noStore }, async () => {
    const state = app.db.prepare("SELECT MAX(rate_date) rateDate,MAX(fetched_at) fetchedAt,COUNT(*) count FROM exchange_rates").get();
    return state;
  });
  app.post("/api/rates/refresh", {
    preHandler: [app.requireAuth, (request, reply) => requireMutationOrigin(app, request, reply)],
    onSend: noStore
  }, async (_request, reply) => {
    try { return await refreshRates(app); }
    catch (error) { return reply.code(502).send(jsonError("RATES_UNAVAILABLE", "Could not update exchange rates", String(error))); }
  });
  app.get("/api/rates/convert", { preHandler: app.requireAuth, onSend: noStore }, async (request, reply) => {
    const q = request.query as { amount?: string; from?: string; to?: string; date?: string };
    const from = q.from?.toUpperCase(), to = q.to?.toUpperCase(), amount = Number(q.amount);
    const date = q.date ?? new Date().toISOString().slice(0, 10);
    if (!from || !to || !isCurrency(from) || !isCurrency(to) || !Number.isFinite(amount) || !isCalendarDate(date)) {
      return reply.code(400).send(jsonError("VALIDATION", "Valid amount, from, to and date are required"));
    }
    await ensureRates(app, date, date);
    const converted = convertMajor(app, amount, from, to, date);
    return converted ? { ...converted, currency: to } : reply.code(503).send(jsonError("RATE_MISSING", "No cached rate is available"));
  });
}

export function startRateScheduler(app: FastifyInstance): () => void {
  let timer: NodeJS.Timeout | undefined;
  const run = async () => {
    try { await refreshRates(app); } catch (error) { app.log.warn({ err: error }, "Scheduled exchange rate refresh failed"); }
    timer = setTimeout(run, 24 * 60 * 60 * 1000);
    timer.unref();
  };
  void run();
  return () => { if (timer) clearTimeout(timer); };
}
