import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { buildApp } from "../src/app.js";
import { cleanupSyncOperations } from "../src/sync.js";
import { createUser } from "../src/users.js";
import { createWorkspace } from "../src/workspaces.js";
import { testConfig } from "./test-app.js";

let app: Awaited<ReturnType<typeof buildApp>>;

before(async () => {
  app = await buildApp(testConfig(), { logger: false, scheduler: false });
});

after(async () => app.close());

test("old sync verdicts are pruned while recent ones keep protecting retries", () => {
  const owner = createUser(app.db, "Владелец");
  const workspace = createWorkspace(app.db, { id: "0d6bd3a2-5a4d-4a8c-9f1e-1b2c3d4e5f60", name: "Дом", ownerUserId: owner.id });
  assert.ok("workspace" in workspace);
  const insert = app.db.prepare("INSERT INTO sync_operations(workspace_id,operation_id,result_json,created_at) VALUES (?,?,?,?)");
  const now = new Date("2026-09-05T10:00:00.000Z");
  insert.run(workspace.workspace.id, "old", "{}", "2026-05-01T10:00:00.000Z");
  insert.run(workspace.workspace.id, "edge", "{}", "2026-06-07T10:00:00.001Z");
  insert.run(workspace.workspace.id, "fresh", "{}", "2026-09-04T10:00:00.000Z");

  assert.equal(cleanupSyncOperations(app.db, now), 1, "only the row older than 90 days goes");
  const left = (app.db.prepare("SELECT operation_id FROM sync_operations ORDER BY operation_id").all() as Array<{ operation_id: string }>).map((row) => row.operation_id);
  assert.deepEqual(left, ["edge", "fresh"]);
});
