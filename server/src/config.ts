import type { AppConfig } from "./types.js";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

export function configFromEnv(): AppConfig {
  const pin = required("APP_PIN");
  const sessionSecret = required("SESSION_SECRET");
  if (sessionSecret.length < 32) throw new Error("SESSION_SECRET must be at least 32 characters");
  return {
    databasePath: process.env.DATABASE_PATH ?? "/data/moapp.sqlite",
    pin,
    sessionSecret,
    sessionTtlDays: Number(process.env.SESSION_TTL_DAYS ?? 30),
    secureCookies: process.env.NODE_ENV !== "test",
    frankfurterUrl: (process.env.FRANKFURTER_URL ?? "https://api.frankfurter.dev/v2").replace(/\/$/, ""),
    defaultAnalyticsCurrency: (process.env.DEFAULT_ANALYTICS_CURRENCY ?? "RSD").toUpperCase()
  };
}
