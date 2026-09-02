import assert from "node:assert/strict";
import test from "node:test";
import { AppDatabase } from "../src/database.ts";
import { HnClient } from "../src/hn-client.ts";
import { SyncService } from "../src/sync-service.ts";

test("imports direct children once and skips nested replies", async () => {
  const requested: number[] = [];
  const items = new Map<number, unknown>([
    [10, { id: 10, type: "story", title: "Ask HN: Who is hiring?", kids: [101, 102] }],
    [101, { id: 101, type: "comment", parent: 10, by: "author", time: 1_788_255_600, text: "Acme | Engineer | REMOTE<p>TypeScript and Postgres.</p>" }],
    [102, { id: 102, type: "comment", parent: 101, by: "reply", time: 1_788_255_601, text: "A nested reply" }],
  ]);
  const fakeFetch: typeof fetch = async (input) => {
    const id = Number(String(input).match(/item\/(\d+)\.json/)?.[1]);
    requested.push(id);
    return new Response(JSON.stringify(items.get(id) ?? null), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  const database = new AppDatabase(":memory:");
  database.activateThread({ id: 10, url: "https://news.ycombinator.com/item?id=10", title: "Ask HN: Who is hiring?" });
  const events: string[] = [];
  const service = new SyncService({
    database,
    hnClient: new HnClient("https://fake.test/v0", 1_000, fakeFetch),
    intervalMs: 300_000,
    concurrency: 2,
    publish: (event) => events.push(event),
  });

  assert.equal(await service.syncActive("manual"), true);
  assert.equal(database.queryJobs({ status: "all", sort: "newest", page: 1 }).total, 1);
  assert.ok(events.includes("jobs-imported"));
  assert.deepEqual(requested, [10, 101, 102]);

  requested.length = 0;
  assert.equal(await service.syncActive("manual"), true);
  assert.deepEqual(requested, [10]);
  database.close();
});

test("cancels the old sync before activating a different thread", async () => {
  let markChildStarted = () => {};
  const childStarted = new Promise<void>((resolve) => { markChildStarted = resolve; });
  const fakeFetch: typeof fetch = async (input, init) => {
    const id = Number(String(input).match(/item\/(\d+)\.json/)?.[1]);
    if (id === 10) return Response.json({ id: 10, type: "story", title: "Ask HN: Who is hiring?", kids: [101] });
    if (id === 20) return Response.json({ id: 20, type: "story", title: "Ask HN: Who is hiring? (next month)", kids: [] });
    if (id === 101) {
      markChildStarted();
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
      });
    }
    return Response.json(null);
  };
  const database = new AppDatabase(":memory:");
  database.activateThread({ id: 10, url: "https://news.ycombinator.com/item?id=10", title: "Old thread" });
  const service = new SyncService({
    database,
    hnClient: new HnClient("https://fake.test/v0", 5_000, fakeFetch),
    intervalMs: 300_000,
    concurrency: 1,
    publish: () => undefined,
  });

  const oldSync = service.syncActive("manual");
  await childStarted;
  await service.activateThreadUrl("https://news.ycombinator.com/item?id=20");
  await oldSync;
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(database.getActiveThread()?.hn_id, 20);
  const oldRun = database.connection
    .prepare("SELECT status FROM sync_runs WHERE thread_hn_id = 10 ORDER BY id DESC LIMIT 1")
    .get() as { status: string };
  assert.equal(oldRun.status, "cancelled");
  assert.equal(database.queryJobs({ status: "all", sort: "newest", page: 1 }).total, 0);
  await service.stop();
  database.close();
});
