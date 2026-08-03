import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import type { FastifyInstance } from "fastify";
import { jsonError } from "./validation.js";

const scrypt = promisify(scryptCallback);
const cookieName = "moapp_session";

async function derive(pin: string, salt: Buffer): Promise<Buffer> {
  return scrypt(pin.normalize("NFKC"), salt, 64) as Promise<Buffer>;
}

export async function registerAuth(app: FastifyInstance): Promise<void> {
  const salt = createHash("sha256").update(app.config.sessionSecret).digest().subarray(0, 16);
  const expectedPin = await derive(app.config.pin, salt);
  const pinFingerprint = createHash("sha256").update(expectedPin).digest("hex");

  app.decorate("requireAuth", async (request, reply) => {
    const raw = request.cookies[cookieName];
    if (!raw) { await reply.code(401).send(jsonError("UNAUTHORIZED", "PIN required")); return; }
    const unsigned = request.unsignCookie(raw);
    if (!unsigned.valid || !unsigned.value) { await reply.code(401).send(jsonError("UNAUTHORIZED", "Invalid session")); return; }
    const hash = createHash("sha256").update(unsigned.value).digest("hex");
    const session = app.db.prepare("SELECT expires_at,pin_fingerprint FROM sessions WHERE token_hash = ?").get(hash) as { expires_at: string; pin_fingerprint: string | null } | undefined;
    if (!session || session.expires_at <= new Date().toISOString() || session.pin_fingerprint !== pinFingerprint) {
      if (session) app.db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(hash);
      await reply.code(401).send(jsonError("UNAUTHORIZED", "Session expired"));
    }
  });

  const loginOptions = {
    config: { rateLimit: { max: 5, timeWindow: "1 minute", ban: 3 } },
    schema: { body: { type: "object", required: ["pin"], additionalProperties: false, properties: { pin: { type: "string", minLength: 1, maxLength: 128 } } } }
  } as const;
  const login = async (request: import("fastify").FastifyRequest, reply: import("fastify").FastifyReply) => {
    const { pin } = request.body as { pin: string };
    const actual = await derive(pin, salt);
    if (!timingSafeEqual(expectedPin, actual)) return reply.code(401).send(jsonError("INVALID_PIN", "Invalid PIN"));
    const token = randomBytes(32).toString("base64url");
    const tokenHash = createHash("sha256").update(token).digest("hex");
    const now = new Date();
    const expires = new Date(now.getTime() + app.config.sessionTtlDays * 86_400_000);
    app.db.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(now.toISOString());
    app.db.prepare("INSERT INTO sessions(token_hash,expires_at,created_at,pin_fingerprint) VALUES (?,?,?,?)")
      .run(tokenHash, expires.toISOString(), now.toISOString(), pinFingerprint);
    return reply.setCookie(cookieName, token, {
      signed: true, httpOnly: true, secure: app.config.secureCookies, sameSite: "strict", path: "/", expires
    }).send({ authenticated: true, expiresAt: expires.toISOString() });
  };
  app.post("/api/auth/login", loginOptions, login);
  app.post("/api/session", loginOptions, login);

  app.post("/api/auth/logout", { preHandler: app.requireAuth }, async (request, reply) => {
    const unsigned = request.unsignCookie(request.cookies[cookieName]!);
    if (unsigned.value) app.db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(createHash("sha256").update(unsigned.value).digest("hex"));
    return reply.clearCookie(cookieName, { path: "/" }).code(204).send();
  });

  app.get("/api/auth/session", { preHandler: app.requireAuth }, async () => ({ authenticated: true }));
  app.get("/api/session", { preHandler: app.requireAuth }, async () => ({ authenticated: true }));
  app.delete("/api/session", { preHandler: app.requireAuth }, async (request, reply) => {
    const raw = request.cookies[cookieName];
    if (raw) {
      const unsigned = request.unsignCookie(raw);
      if (unsigned.value) app.db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(createHash("sha256").update(unsigned.value).digest("hex"));
    }
    return reply.clearCookie(cookieName, { path: "/" }).code(204).send();
  });
}
