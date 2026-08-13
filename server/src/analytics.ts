import type { FastifyInstance } from "fastify";
import type { ExpenseRow } from "./expenses.js";
import { convertMajor, ensureRates } from "./rates.js";
import { hasWorkspaceMembership, noStore, sendWorkspaceNotFound, workspaceContext } from "./tenant-domain-guard.js";
import { isCurrency, jsonError, minorDigits } from "./validation.js";

type Point = { amountMinor: number; count: number };

const APP_TIME_ZONE = "Europe/Belgrade";

function localDateKey(value: string | Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: APP_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(typeof value === "string" ? new Date(value) : value);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

export async function registerAnalyticsRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/workspaces/:workspaceId/analytics", {
    preHandler: app.requireWorkspaceMember,
    onSend: noStore
  }, async (request, reply) => {
    const { workspaceId, userId } = workspaceContext(request);
    const q = request.query as { from?: string; to?: string; currency?: string; categoryId?: string };
    const today = localDateKey(new Date());
    const defaultFrom = `${today.slice(0, 8)}01`;
    const from = q.from ?? defaultFrom;
    const to = q.to ?? today;
    const categoryId = q.categoryId?.trim();
    const target = (q.currency ?? app.config.defaultAnalyticsCurrency).toUpperCase();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to) || from > to || !isCurrency(target)) {
      return reply.code(400).send(jsonError("VALIDATION", "Valid from, to and currency are required"));
    }

    await ensureRates(app, from, to);

    // ensureRates performs network I/O. Membership must be checked again before
    // any tenant data is read, in case access was removed while rates loaded.
    if (!hasWorkspaceMembership(app, workspaceId, userId)) return sendWorkspaceNotFound(reply);
    if (categoryId && !app.db.prepare("SELECT 1 FROM categories WHERE workspace_id=? AND id=?")
      .get(workspaceId, categoryId)) {
      return reply.code(400).send(jsonError("VALIDATION", "Category not found"));
    }

    // Timestamps are UTC instants while filters are Europe/Belgrade calendar
    // dates. SQL establishes tenant/deletion/category scope before the calendar
    // conversion is applied in memory.
    const rows = (app.db.prepare(`SELECT * FROM expenses
      WHERE workspace_id=? AND deleted_at IS NULL ${categoryId ? "AND category_id=?" : ""}
      ORDER BY occurred_at`).all(...(categoryId ? [workspaceId, categoryId] : [workspaceId])) as ExpenseRow[])
      .filter((row) => {
        const date = localDateKey(row.occurred_at);
        return date >= from && date <= to;
      });
    const categories = new Map<string, Point>();
    const daily = new Map<string, Point>();
    const weekdays = Array.from({ length: 7 }, () => ({ amountMinor: 0, count: 0 }));
    const missing = new Set<string>();
    let totalMinor = 0;
    let convertedCount = 0;
    let oldestRateDate: string | undefined;
    const targetDigits = minorDigits(target);
    for (const row of rows) {
      const date = localDateKey(row.occurred_at);
      const sourceDigits = minorDigits(row.currency);
      const converted = convertMajor(app, row.amount_minor / 10 ** sourceDigits, row.currency, target, date);
      if (!converted) { missing.add(row.currency); continue; }
      const amountMinor = Math.round(converted.amount * 10 ** targetDigits);
      convertedCount++;
      totalMinor += amountMinor;
      oldestRateDate = !oldestRateDate || converted.rateDate < oldestRateDate ? converted.rateDate : oldestRateDate;
      const day = daily.get(date) ?? { amountMinor: 0, count: 0 };
      day.amountMinor += amountMinor;
      day.count++;
      daily.set(date, day);
      const category = categories.get(row.category_id) ?? { amountMinor: 0, count: 0 };
      category.amountMinor += amountMinor;
      category.count++;
      categories.set(row.category_id, category);
      const weekday = new Date(`${date}T12:00:00Z`).getUTCDay();
      weekdays[weekday]!.amountMinor += amountMinor;
      weekdays[weekday]!.count++;
    }
    const names = new Map((app.db.prepare(`SELECT id,name,color FROM categories WHERE workspace_id=?`)
      .all(workspaceId) as Array<{ id: string; name: string; color: string | null }>).map((category) => [category.id, category]));
    return {
      currency: target,
      from,
      to,
      totalMinor,
      expenseCount: rows.length,
      convertedCount,
      rateDate: oldestRateDate ?? null,
      missingCurrencies: [...missing],
      daily: [...daily].map(([date, point]) => ({ date, ...point })),
      categories: [...categories]
        .map(([id, point]) => ({ categoryId: id, name: names.get(id)?.name ?? "Unknown", color: names.get(id)?.color ?? null, ...point }))
        .sort((a, b) => b.amountMinor - a.amountMinor),
      weekdays: weekdays.map((point, weekday) => ({ weekday, ...point })),
      calendar: [...daily].map(([date, point]) => ({ date, ...point }))
    };
  });
}
