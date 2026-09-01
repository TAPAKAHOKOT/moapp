import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { configFromEnv } from "../src/config.js";

const MANAGED_KEYS = [
  "NODE_ENV",
  "SESSION_SECRET",
  "INTEGRATION_ENCRYPTION_KEY",
  "BYBIT_API_BASE_URL",
  "APP_ORIGIN",
  "APP_PIN",
  "INVITATION_TTL_HOURS",
  "DEVICE_LINK_TTL_MINUTES"
] as const;

const original = new Map(MANAGED_KEYS.map((key) => [key, process.env[key]]));

function restoreEnvironment(): void {
  for (const key of MANAGED_KEYS) {
    const value = original.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

afterEach(restoreEnvironment);

function minimalProductionEnvironment(): void {
  process.env.NODE_ENV = "production";
  process.env.SESSION_SECRET = "a-production-secret-with-at-least-thirty-two-characters";
  process.env.INTEGRATION_ENCRYPTION_KEY = "an-independent-integration-secret-with-at-least-thirty-two-characters";
  delete process.env.APP_PIN;
  delete process.env.INVITATION_TTL_HOURS;
  delete process.env.DEVICE_LINK_TTL_MINUTES;
}

test("production configuration requires an exact public origin", () => {
  minimalProductionEnvironment();
  delete process.env.APP_ORIGIN;
  assert.throws(() => configFromEnv(), /APP_ORIGIN is required/);

  for (const invalid of ["https://moapp.example/path", "https://moapp.example/#/join/secret", "ftp://moapp.example"]) {
    process.env.APP_ORIGIN = invalid;
    assert.throws(() => configFromEnv(), /APP_ORIGIN must be an http\(s\) origin/);
  }
});

test("production configuration trims transitional PIN and reads access overrides", () => {
  minimalProductionEnvironment();
  process.env.APP_ORIGIN = "https://moapp.example";
  process.env.APP_PIN = "   ";
  process.env.INVITATION_TTL_HOURS = "96";
  process.env.DEVICE_LINK_TTL_MINUTES = "10";

  const config = configFromEnv();
  assert.equal(config.pin, undefined);
  assert.equal(config.secureCookies, true);
  assert.equal(config.appOrigin, "https://moapp.example");
  assert.equal(config.access.invitationTtlHours, 96);
  assert.equal(config.access.deviceLinkTtlMinutes, 10);
  assert.equal(config.access.recoveryRotationTtlMinutes, 30);
});

test("local development uses the localhost origin and non-secure cookie", () => {
  delete process.env.NODE_ENV;
  delete process.env.APP_ORIGIN;
  process.env.SESSION_SECRET = "a-development-secret-with-at-least-thirty-two-characters";
  process.env.INTEGRATION_ENCRYPTION_KEY = "a-development-integration-secret-with-at-least-thirty-two-characters";
  const config = configFromEnv();
  assert.equal(config.appOrigin, "http://localhost:5173");
  assert.equal(config.secureCookies, false);
});

test("a Bybit API override is restricted to a local development origin", () => {
  delete process.env.NODE_ENV;
  process.env.SESSION_SECRET = "a-development-secret-with-at-least-thirty-two-characters";
  process.env.INTEGRATION_ENCRYPTION_KEY = "a-development-integration-secret-with-at-least-thirty-two-characters";
  process.env.BYBIT_API_BASE_URL = "http://127.0.0.1:4010";
  assert.equal(configFromEnv().bybitApiBaseUrl, "http://127.0.0.1:4010");

  process.env.BYBIT_API_BASE_URL = "https://api.example.com";
  assert.throws(() => configFromEnv(), /must be a local http origin/);

  minimalProductionEnvironment();
  process.env.APP_ORIGIN = "https://moapp.example";
  process.env.BYBIT_API_BASE_URL = "http://127.0.0.1:4010";
  assert.throws(() => configFromEnv(), /available only outside production/);
});

test("session secrets and numeric limits fail closed", () => {
  minimalProductionEnvironment();
  process.env.APP_ORIGIN = "https://moapp.example";
  process.env.SESSION_SECRET = "too-short";
  assert.throws(() => configFromEnv(), /SESSION_SECRET must be at least 32 characters/);

  process.env.SESSION_SECRET = "a-production-secret-with-at-least-thirty-two-characters";
  process.env.INTEGRATION_ENCRYPTION_KEY = "too-short";
  assert.throws(() => configFromEnv(), /INTEGRATION_ENCRYPTION_KEY must be at least 32 characters/);

  process.env.INTEGRATION_ENCRYPTION_KEY = "an-independent-integration-secret-with-at-least-thirty-two-characters";
  process.env.INVITATION_TTL_HOURS = "0";
  assert.throws(() => configFromEnv(), /INVITATION_TTL_HOURS must be a positive integer/);

  process.env.INVITATION_TTL_HOURS = "169";
  assert.throws(() => configFromEnv(), /INVITATION_TTL_HOURS must be between 24 and 168/);
});
