import Fastify, { type FastifyError } from "fastify";
import cookie from "@fastify/cookie";
import rateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { AppConfig } from "./types.js";
import { openDatabase, startBackupHeartbeat } from "./db.js";
import { registerAuth } from "./auth.js";
import { registerCoreRoutes } from "./core.js";
import { registerTenantDomainRoutes } from "./tenant-domain.js";
import { registerAccessRoutes, cleanupExpiredAccessRows } from "./access/index.js";
import { startRateScheduler } from "./rates.js";
import { jsonError } from "./validation.js";
import { cleanupExpiredOAuthRows, registerOAuthRoutes } from "./oauth.js";
import { registerMcpRoutes } from "./mcp.js";
import { cleanupSyncOperations } from "./sync.js";
import { registerBybitCardRoutes, startBybitCardScheduler } from "./bybit-card.js";

function loggerOptions(enabled: boolean | undefined) {
  if (enabled === false) return false;
  return {
    level: "info",
    redact: {
      paths: [
        "req.headers.cookie", "req.headers.authorization", "req.body.pin", "req.body.token",
        "req.body.attemptToken", "req.body.completionToken", "req.body.code", "req.body.code_verifier",
        "req.body.refresh_token", "req.body.csrf_token", "pin", "token", "code", "code_verifier",
        "refresh_token", "csrf_token", "attemptToken", "completionToken", "req.body.apiKey", "req.body.apiSecret",
        "apiKey", "apiSecret", "credentials_encrypted"
      ] as string[],
      censor: "[REDACTED]"
    }
  };
}

export async function buildApp(config: AppConfig, options: { logger?: boolean; scheduler?: boolean; staticRoot?: string } = {}) {
  const app = Fastify({ logger: loggerOptions(options.logger), trustProxy: 1, bodyLimit: 1024 * 1024 });
  const db = openDatabase(config.databasePath);
  const stopBackupHeartbeat = startBackupHeartbeat(db);
  app.decorate("db", db);
  app.decorate("config", config);
  await app.register(cookie, { secret: config.sessionSecret, hook: "onRequest" });
  await app.register(rateLimit, {
    global: true,
    max: 300,
    timeWindow: "1 minute",
    errorResponseBuilder: () => ({ statusCode: 429, message: "Too many requests; try again later" })
  });
  app.addHook("onSend", async (request, reply, payload) => {
    void reply.header("Referrer-Policy", "no-referrer");
    void reply.header("X-Content-Type-Options", "nosniff");
    void reply.header("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; worker-src 'self'; manifest-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    if (config.appOrigin.startsWith("https://")) void reply.header("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
    if (request.url.startsWith("/api/") && request.url.split("?", 1)[0] !== "/api/health") {
      void reply.header("Cache-Control", "private, no-store");
    }
    return payload;
  });
  app.addHook("onClose", async () => {
    stopBackupHeartbeat();
    db.close();
  });

  // Health is polled by Docker, the deploy script and every client probe: a cheap read, not a whole-file integrity scan.
  app.get("/api/health", async () => {
    const database = db.prepare("SELECT 1").pluck().get() === 1 ? "ok" : "degraded";
    return { status: database, database, time: new Date().toISOString() };
  });
  await registerAuth(app);
  await registerOAuthRoutes(app);
  await registerMcpRoutes(app);
  await registerCoreRoutes(app);
  await registerTenantDomainRoutes(app);
  await registerAccessRoutes(app);
  await registerBybitCardRoutes(app);

  const clientRoot = options.staticRoot ?? resolve(process.cwd(), "../client/dist");
  if (existsSync(resolve(clientRoot, "index.html"))) {
    await app.register(fastifyStatic, { root: clientRoot, wildcard: false });
  }
  app.setNotFoundHandler(async (request, reply) => {
    const pathname = request.url.split("?", 1)[0] ?? request.url;
    if (pathname.startsWith("/api/")) return reply.code(404).send(jsonError("NOT_FOUND", "API route not found"));
    // Never let the SPA fallback turn a missing hashed asset into a successful
    // HTML response: a service worker could cache that HTML under the JS/CSS URL
    // and leave the application blank even after the server is restarted.
    if (pathname.startsWith("/assets/") || pathname === "/sw.js" || pathname === "/manifest.webmanifest" || pathname === "/icon.svg"
      || /^\/(?:apple-touch-icon|icon-\d+)\.png$/.test(pathname)) {
      return reply.code(404).send(jsonError("NOT_FOUND", "Static asset not found"));
    }
    if (existsSync(resolve(clientRoot, "index.html"))) return reply.type("text/html").sendFile("index.html");
    return reply.code(404).send(jsonError("NOT_FOUND", "Not found"));
  });
  app.setErrorHandler((error: FastifyError, request, reply) => {
    request.log.error({ err: error }, "Request failed");
    const status = error.statusCode && error.statusCode >= 400 && error.statusCode < 500 ? error.statusCode : 500;
    const code = status === 500 ? "INTERNAL" : status === 429 ? "RATE_LIMITED" : "REQUEST_ERROR";
    const message = status === 500 ? "Internal server error" : status === 429 ? "Too many requests; try again later" : error.message;
    return reply.code(status).send(jsonError(code, message));
  });

  if (options.scheduler !== false) {
    const stop = startRateScheduler(app);
    const stopBybitCard = startBybitCardScheduler(app);
    cleanupExpiredAccessRows(db);
    cleanupExpiredOAuthRows(db);
    cleanupSyncOperations(db);
    const accessCleanup = setInterval(() => cleanupExpiredAccessRows(db), 6 * 60 * 60 * 1000);
    const oauthCleanup = setInterval(() => cleanupExpiredOAuthRows(db), 6 * 60 * 60 * 1000);
    const syncCleanup = setInterval(() => cleanupSyncOperations(db), 6 * 60 * 60 * 1000);
    accessCleanup.unref();
    oauthCleanup.unref();
    syncCleanup.unref();
    app.addHook("onClose", async () => {
      stop();
      stopBybitCard();
      clearInterval(accessCleanup);
      clearInterval(oauthCleanup);
      clearInterval(syncCleanup);
    });
  }
  return app;
}
