import cookie from "@fastify/cookie";
import rateLimit from "@fastify/rate-limit";
import Fastify, { type FastifyInstance } from "fastify";
import { registerAuth } from "../src/auth.js";
import { registerCoreRoutes } from "../src/core.js";
import { openDatabase } from "../src/db.js";
import type { AppConfig } from "../src/types.js";
import { jsonError } from "../src/validation.js";

export type TestRoutePlugin = (app: FastifyInstance) => Promise<void> | void;

export function testConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    databasePath: ":memory:",
    pin: "2468",
    sessionSecret: "a-test-session-secret-that-is-longer-than-thirty-two-characters",
    sessionTtlDays: 30,
    secureCookies: false,
    appOrigin: "http://moapp.test",
    access: {
      invitationTtlHours: 72,
      invitationMinTtlHours: 24,
      invitationMaxTtlHours: 168,
      maxActiveInvitations: 20,
      deviceLinkTtlMinutes: 15,
      recoveryRotationTtlMinutes: 30,
      legacyClaimTtlMinutes: 30,
      accessPreviewRateLimitPerMinute: 20,
      invitationRateLimitPerHour: 10,
      deviceLinkRateLimitPerHour: 5,
      recoveryPrepareRateLimitPerFifteenMinutes: 5,
      manualRecoveryRateLimitPerHour: 3
    },
    frankfurterUrl: "https://example.invalid/v2",
    defaultAnalyticsCurrency: "RSD",
    integrationEncryptionKey: "a-test-integration-key-that-is-longer-than-thirty-two-characters",
    ...overrides
  };
}

export async function buildTestApp(options: { config?: AppConfig; plugins?: TestRoutePlugin[] } = {}): Promise<FastifyInstance> {
  const config = options.config ?? testConfig();
  const app = Fastify({ logger: false, trustProxy: 1 });
  app.decorate("db", openDatabase(config.databasePath));
  app.decorate("config", config);
  await app.register(cookie, { secret: config.sessionSecret, hook: "onRequest" });
  await app.register(rateLimit, {
    global: false,
    errorResponseBuilder: () => ({ statusCode: 429, message: "Too many requests; try again later" })
  });
  await registerAuth(app);
  await registerCoreRoutes(app);
  for (const plugin of options.plugins ?? []) await plugin(app);
  app.setErrorHandler((error, _request, reply) => {
    const status = error.statusCode && error.statusCode >= 400 && error.statusCode < 500 ? error.statusCode : 500;
    const code = status === 500 ? "INTERNAL" : status === 429 ? "RATE_LIMITED" : "REQUEST_ERROR";
    const message = status === 500 ? "Internal server error" : status === 429 ? "Too many requests; try again later" : error.message;
    return reply.code(status).send(jsonError(code, message));
  });
  app.addHook("onClose", async () => app.db.close());
  await app.ready();
  return app;
}
