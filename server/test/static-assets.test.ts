import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { buildApp } from "../src/app.js";
import { testConfig } from "./test-app.js";

test("SPA fallback never serves HTML for a missing static asset", async () => {
  const staticRoot = mkdtempSync(join(tmpdir(), "moapp-static-"));
  mkdirSync(join(staticRoot, "assets"));
  writeFileSync(join(staticRoot, "index.html"), "<!doctype html><title>Moapp</title><div id=\"root\"></div>");
  writeFileSync(join(staticRoot, "assets", "app.js"), "console.log('ok')");
  const app = await buildApp(testConfig(), { logger: false, scheduler: false, staticRoot });

  try {
    const existing = await app.inject({ method: "GET", url: "/assets/app.js" });
    assert.equal(existing.statusCode, 200);
    assert.match(String(existing.headers["content-type"]), /javascript/);

    const missing = await app.inject({ method: "GET", url: "/assets/missing-hash.js" });
    assert.equal(missing.statusCode, 404);
    assert.deepEqual(missing.json(), { error: { code: "NOT_FOUND", message: "Static asset not found" } });

    const deepLink = await app.inject({ method: "GET", url: "/settings/integrations" });
    assert.equal(deepLink.statusCode, 200);
    assert.match(String(deepLink.headers["content-type"]), /text\/html/);
  } finally {
    await app.close();
    rmSync(staticRoot, { recursive: true, force: true });
  }
});
