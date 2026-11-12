import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createStore } from "../lib/store.mjs";

test("json store persists documents and survives a restart", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "w2w-store-"));
  try {
    const store = await createStore({ dataDir });
    await store.put("listings", "a", { id: "a", title: "Oak offcuts" });
    const reopened = await createStore({ dataDir });
    assert.equal(reopened.get("listings", "a").title, "Oak offcuts");
    assert.equal(reopened.count("listings"), 1);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("json store keeps saving after a failed write", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "w2w-store-"));
  const blocker = path.join(dataDir, "runtime.json.tmp");
  try {
    const store = await createStore({ dataDir });
    await mkdir(blocker);
    await assert.rejects(store.put("deals", "d1", { id: "d1" }));
    await rm(blocker, { recursive: true });
    await store.put("deals", "d2", { id: "d2" });
    const saved = JSON.parse(await readFile(path.join(dataDir, "runtime.json"), "utf8"));
    assert.deepEqual(saved.collections.deals.map((deal) => deal.id).sort(), ["d1", "d2"]);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});
