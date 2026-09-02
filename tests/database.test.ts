import assert from "node:assert/strict";
import test from "node:test";
import { AppDatabase } from "../src/database.ts";
import { parseJobPost } from "../src/parser.ts";

function insertJob(database: AppDatabase, id: number, threadId: number, postedAt: string): void {
  database.insertJob({
    ...parseJobPost(`Company ${id} | Engineer | REMOTE<p>Body for ${id}</p>`),
    hnId: id,
    threadHnId: threadId,
    author: "tester",
    postedAt,
    originalUrl: `https://news.ycombinator.com/item?id=${id}`,
  });
}

test("stores jobs idempotently and filters seen jobs", () => {
  const database = new AppDatabase(":memory:");
  database.activateThread({ id: 10, url: "https://news.ycombinator.com/item?id=10", title: "Ask HN: Who is hiring?" });
  insertJob(database, 101, 10, "2026-09-01T10:00:00.000Z");
  insertJob(database, 102, 10, "2026-09-01T11:00:00.000Z");
  insertJob(database, 102, 10, "2026-09-01T11:00:00.000Z");

  const unseen = database.queryJobs({ status: "unseen", sort: "newest", page: 1 });
  assert.equal(unseen.total, 2);
  assert.deepEqual(unseen.jobs.map((job) => job.hn_id), [102, 101]);

  assert.equal(database.setSeen(102, true), true);
  assert.deepEqual(
    database.queryJobs({ status: "unseen", sort: "newest", page: 1 }).jobs.map((job) => job.hn_id),
    [101],
  );
  assert.deepEqual(
    database.queryJobs({ status: "seen", sort: "newest", page: 1 }).jobs.map((job) => job.hn_id),
    [102],
  );
  database.close();
});

test("switches active threads atomically while retaining historical jobs", () => {
  const database = new AppDatabase(":memory:");
  database.activateThread({ id: 10, url: "https://news.ycombinator.com/item?id=10", title: "August jobs" });
  insertJob(database, 101, 10, "2026-08-01T10:00:00.000Z");
  database.activateThread({ id: 20, url: "https://news.ycombinator.com/item?id=20", title: "September jobs" });
  insertJob(database, 201, 20, "2026-09-01T10:00:00.000Z");

  assert.equal(database.getActiveThread()?.hn_id, 20);
  assert.equal(database.getThreads().filter((thread) => thread.is_active).length, 1);
  assert.equal(database.queryJobs({ status: "all", sort: "newest", page: 1 }).total, 2);
  assert.equal(database.queryJobs({ status: "all", sort: "newest", page: 1, threadId: 10 }).total, 1);
  database.close();
});
