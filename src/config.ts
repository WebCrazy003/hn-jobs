import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

const projectRoot = resolve(import.meta.dirname, "..");
const dataDirectory = resolve(projectRoot, "data");
mkdirSync(dataDirectory, { recursive: true });

export const config = {
  projectRoot,
  publicDirectory: resolve(projectRoot, "public"),
  databasePath: process.env.HN_JOBS_DB_PATH || resolve(dataDirectory, "hn-jobs.sqlite"),
  hostname: process.env.HOST || "127.0.0.1",
  port: Number(process.env.PORT || 3000),
  syncIntervalMs: Number(process.env.SYNC_INTERVAL_MS || 5 * 60 * 1000),
  hnApiBaseUrl: process.env.HN_API_BASE_URL || "https://hacker-news.firebaseio.com/v0",
  requestTimeoutMs: Number(process.env.HN_REQUEST_TIMEOUT_MS || 10_000),
  fetchConcurrency: Number(process.env.HN_FETCH_CONCURRENCY || 10),
};
