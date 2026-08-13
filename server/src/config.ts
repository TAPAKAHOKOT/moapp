import type { AppConfig } from "./types.js";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function positiveInteger(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}

function configuredOrigin(): string {
  const configured = process.env.APP_ORIGIN?.trim();
  if (!configured && process.env.NODE_ENV === "production") throw new Error("APP_ORIGIN is required in production");
  const parsed = new URL(configured ?? "http://localhost:5173");
  if (parsed.origin !== parsed.href.replace(/\/$/, "") || (parsed.protocol !== "http:" && parsed.protocol !== "https:")) {
    throw new Error("APP_ORIGIN must be an http(s) origin without a path, query, or fragment");
  }
  return parsed.origin;
}

export function configFromEnv(): AppConfig {
  const pin = process.env.APP_PIN?.trim() || undefined;
  const sessionSecret = required("SESSION_SECRET");
  if (sessionSecret.length < 32) throw new Error("SESSION_SECRET must be at least 32 characters");
  return {
    databasePath: process.env.DATABASE_PATH ?? "/data/moapp.sqlite",
    ...(pin === undefined ? {} : { pin }),
    sessionSecret,
    sessionTtlDays: positiveInteger("SESSION_TTL_DAYS", 30),
    secureCookies: process.env.NODE_ENV !== "test",
    appOrigin: configuredOrigin(),
    access: {
      invitationTtlHours: positiveInteger("INVITATION_TTL_HOURS", 72),
      invitationMinTtlHours: 24,
      invitationMaxTtlHours: 168,
      maxActiveInvitations: positiveInteger("MAX_ACTIVE_INVITATIONS", 20),
      deviceLinkTtlMinutes: positiveInteger("DEVICE_LINK_TTL_MINUTES", 15),
      recoveryRotationTtlMinutes: positiveInteger("RECOVERY_ROTATION_TTL_MINUTES", 30),
      legacyClaimTtlMinutes: positiveInteger("LEGACY_CLAIM_TTL_MINUTES", 30),
      accessPreviewRateLimitPerMinute: positiveInteger("ACCESS_PREVIEW_RATE_LIMIT_PER_MINUTE", 20),
      invitationRateLimitPerHour: positiveInteger("INVITATION_RATE_LIMIT_PER_HOUR", 10),
      deviceLinkRateLimitPerHour: positiveInteger("DEVICE_LINK_RATE_LIMIT_PER_HOUR", 5),
      recoveryPrepareRateLimitPerFifteenMinutes: positiveInteger("RECOVERY_PREPARE_RATE_LIMIT_PER_15_MINUTES", 5),
      manualRecoveryRateLimitPerHour: positiveInteger("MANUAL_RECOVERY_RATE_LIMIT_PER_HOUR", 3)
    },
    frankfurterUrl: (process.env.FRANKFURTER_URL ?? "https://api.frankfurter.dev/v2").replace(/\/$/, ""),
    defaultAnalyticsCurrency: (process.env.DEFAULT_ANALYTICS_CURRENCY ?? "RSD").toUpperCase()
  };
}
