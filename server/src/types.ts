import type { Database } from "better-sqlite3";

export type AppConfig = {
  databasePath: string;
  pin: string;
  sessionSecret: string;
  sessionTtlDays: number;
  secureCookies: boolean;
  frankfurterUrl: string;
  defaultAnalyticsCurrency: string;
};

declare module "fastify" {
  interface FastifyInstance {
    db: Database;
    config: AppConfig;
    requireAuth: (request: import("fastify").FastifyRequest, reply: import("fastify").FastifyReply) => Promise<void>;
  }
}

export type ExpenseRow = {
  id: string;
  amount_minor: number;
  currency: string;
  category_id: string;
  occurred_at: string;
  note: string | null;
  version: number;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
};

export type CategoryRow = {
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
