import type { FastifyInstance } from "fastify";
import type { ExpenseRow } from "./expenses.js";
import { convertMajor, ensureRates } from "./rates.js";
import { hasWorkspaceMembership, noStore, sendWorkspaceNotFound, workspaceContext } from "./tenant-domain-guard.js";
import { isCalendarDate, isCurrency, jsonError, minorDigits } from "./validation.js";
import { localDateKey, requestTimeZone } from "./calendar.js";
import { getWorkspaceCurrency } from "./workspaces.js";

type Point = { amountMinor: number; count: number };

const UNTAGGED = "none";

export async function registerAnalyticsRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/workspaces/:workspaceId/analytics", {
    preHandler: app.requireWorkspaceMember,
    onSend: noStore
  }, async (request, reply) => {
    const { workspaceId, userId } = workspaceContext(request);
    const q = request.query as { from?: string; to?: string; currency?: string; categoryId?: string; tagId?: string; tz?: string };
    const timeZone = requestTimeZone(q.tz);
    const today = localDateKey(new Date(), timeZone);
    const defaultFrom = `${today.slice(0, 8)}01`;
    const from = q.from ?? defaultFrom;
    const to = q.to ?? today;
    const categoryId = q.categoryId?.trim();
    // tagId=none — записи без тегов.
    const tagId = q.tagId?.trim() || undefined;
    const target = (q.currency ?? getWorkspaceCurrency(app.db, workspaceId) ?? app.config.defaultAnalyticsCurrency).toUpperCase();
    if (!isCalendarDate(from) || !isCalendarDate(to) || from > to || !isCurrency(target)) {
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
    if (tagId && tagId !== UNTAGGED && !app.db.prepare("SELECT 1 FROM tags WHERE workspace_id=? AND id=?")
      .get(workspaceId, tagId)) {
      return reply.code(400).send(jsonError("VALIDATION", "Tag not found"));
    }

    // Timestamps are UTC instants while filters are calendar dates in the
    // client's zone. SQL establishes tenant/deletion/category scope before the
    // calendar conversion is applied in memory.
    const rows = (app.db.prepare(`SELECT * FROM expenses
      WHERE workspace_id=? AND deleted_at IS NULL AND voided_at IS NULL ${categoryId ? "AND category_id=?" : ""}
      ORDER BY occurred_at`).all(...(categoryId ? [workspaceId, categoryId] : [workspaceId])) as ExpenseRow[])
      .filter((row) => {
        const date = localDateKey(row.occurred_at, timeZone);
        return date >= from && date <= to;
      });
    const tagsOf = new Map<string, string[]>();
    for (const link of app.db.prepare("SELECT expense_id,tag_id FROM expense_tags WHERE workspace_id=?")
      .all(workspaceId) as Array<{ expense_id: string; tag_id: string }>) {
      tagsOf.set(link.expense_id, [...(tagsOf.get(link.expense_id) ?? []), link.tag_id]);
    }
    // Запись с несколькими тегами делится между ними поровну: доли тегов складываются в итог,
    // а в фокусе на теге он получает только свою долю каждой записи.
    const scoped = tagId
      ? rows.filter((row) => tagId === UNTAGGED ? !tagsOf.get(row.id)?.length : tagsOf.get(row.id)?.includes(tagId))
      : rows;
    const share = (row: ExpenseRow) => tagId && tagId !== UNTAGGED ? 1 / tagsOf.get(row.id)!.length : 1;
    const tags = new Map<string, Point>();
    const categories = new Map<string, Point>();
    const daily = new Map<string, Point>();
    const weekdays = Array.from({ length: 7 }, () => ({ amountMinor: 0, count: 0 }));
    const missing = new Set<string>();
    let totalMinor = 0;
    let convertedCount = 0;
    let oldestRateDate: string | undefined;
    const targetDigits = minorDigits(target);
    for (const row of scoped) {
      const date = localDateKey(row.occurred_at, timeZone);
      const sourceDigits = minorDigits(row.currency);
      const converted = convertMajor(app, row.amount_minor / 10 ** sourceDigits, row.currency, target, date);
      if (!converted) { missing.add(row.currency); continue; }
      const amountMinor = Math.round(converted.amount * share(row) * 10 ** targetDigits);
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
      const rowTags = tagId ? [tagId] : tagsOf.get(row.id)?.length ? tagsOf.get(row.id)! : [UNTAGGED];
      for (const id of rowTags) {
        const tag = tags.get(id) ?? { amountMinor: 0, count: 0 };
        tag.amountMinor += Math.round(amountMinor / rowTags.length);
        tag.count++;
        tags.set(id, tag);
      }
      const weekday = new Date(`${date}T12:00:00Z`).getUTCDay();
      weekdays[weekday]!.amountMinor += amountMinor;
      weekdays[weekday]!.count++;
    }
    const names = new Map((app.db.prepare(`SELECT id,name,color FROM categories WHERE workspace_id=?`)
      .all(workspaceId) as Array<{ id: string; name: string; color: string | null }>).map((category) => [category.id, category]));
    const tagNames = new Map((app.db.prepare(`SELECT id,name,color FROM tags WHERE workspace_id=?`)
      .all(workspaceId) as Array<{ id: string; name: string; color: string | null }>).map((tag) => [tag.id, tag]));
    return {
      currency: target,
      timeZone,
      from,
      to,
      totalMinor,
      expenseCount: scoped.length,
      convertedCount,
      rateDate: oldestRateDate ?? null,
      missingCurrencies: [...missing],
      daily: [...daily].map(([date, point]) => ({ date, ...point })),
      categories: [...categories]
        .map(([id, point]) => ({ categoryId: id, name: names.get(id)?.name ?? "Unknown", color: names.get(id)?.color ?? null, ...point }))
        .sort((a, b) => b.amountMinor - a.amountMinor),
      tags: [...tags]
        .map(([id, point]) => ({ tagId: id === UNTAGGED ? null : id, name: id === UNTAGGED ? null : tagNames.get(id)?.name ?? "Unknown", color: id === UNTAGGED ? null : tagNames.get(id)?.color ?? null, ...point }))
        .sort((a, b) => b.amountMinor - a.amountMinor),
      weekdays: weekdays.map((point, weekday) => ({ weekday, ...point })),
      calendar: [...daily].map(([date, point]) => ({ date, ...point }))
    };
  });
}
