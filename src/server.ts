import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { config } from "./config.ts";
import { AppDatabase } from "./database.ts";
import { HnClient } from "./hn-client.ts";
import { SyncService } from "./sync-service.ts";

const database = new AppDatabase(config.databasePath);
const hnClient = new HnClient(config.hnApiBaseUrl, config.requestTimeoutMs);
const eventClients = new Set<ServerResponse>();

function publish(event: string, data: Record<string, unknown>): void {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of eventClients) client.write(payload);
}

const syncService = new SyncService({
  database,
  hnClient,
  intervalMs: config.syncIntervalMs,
  concurrency: config.fetchConcurrency,
  publish,
});

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(body));
}

function sendError(response: ServerResponse, status: number, code: string, message: string): void {
  sendJson(response, status, { error: { code, message } });
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk);
    size += buffer.length;
    if (size > 16_384) throw new Error("Request body is too large.");
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as Record<string, unknown>;
  } catch {
    throw new Error("Request body must be valid JSON.");
  }
}

function validIso(value: string | null): string | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

async function serveStatic(pathname: string, response: ServerResponse): Promise<void> {
  const requested = pathname === "/" || pathname === "/jobs" || pathname === "/settings"
    ? "index.html"
    : pathname.slice(1);
  const allowed = new Set(["index.html", "app.js", "styles.css"]);
  if (!allowed.has(requested)) {
    sendError(response, 404, "NOT_FOUND", "Not found.");
    return;
  }
  const path = resolve(config.publicDirectory, requested);
  const content = await readFile(path);
  const contentTypes: Record<string, string> = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
  };
  response.writeHead(200, {
    "content-type": contentTypes[extname(path)] || "application/octet-stream",
    "cache-control": requested === "index.html" ? "no-cache" : "public, max-age=300",
  });
  response.end(content);
}

async function route(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);
  const pathname = url.pathname;

  if (request.method === "GET" && pathname === "/api/events") {
    response.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    response.write(`event: connected\ndata: {"ok":true}\n\n`);
    eventClients.add(response);
    const keepAlive = setInterval(() => response.write(": keep-alive\n\n"), 20_000);
    request.on("close", () => {
      clearInterval(keepAlive);
      eventClients.delete(response);
    });
    return;
  }

  if (request.method === "GET" && pathname === "/api/settings") {
    const active = database.getActiveThread();
    sendJson(response, 200, {
      active: active || null,
      threads: database.getThreads(),
      latestSync: active ? database.getLatestSyncRun(active.hn_id) || null : null,
      pollingIntervalMs: config.syncIntervalMs,
    });
    return;
  }

  if (request.method === "PUT" && pathname === "/api/settings/active-thread") {
    const body = await readJson(request);
    if (typeof body.url !== "string") {
      sendError(response, 400, "INVALID_URL", "Thread URL is required.");
      return;
    }
    try {
      const active = await syncService.activateThreadUrl(body.url);
      sendJson(response, 202, { active });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to activate the thread.";
      sendError(response, 400, "INVALID_THREAD", message);
    }
    return;
  }

  if (request.method === "POST" && pathname === "/api/sync") {
    if (!database.getActiveThread()) {
      sendError(response, 409, "NO_ACTIVE_THREAD", "Configure an active thread first.");
      return;
    }
    const started = syncService.requestSync("manual");
    sendJson(response, started ? 202 : 409, {
      started,
      message: started ? "Sync started." : "A sync is already running.",
    });
    return;
  }

  if (request.method === "GET" && pathname === "/api/jobs") {
    const statusValue = url.searchParams.get("status");
    const sortValue = url.searchParams.get("sort");
    const status = statusValue === "seen" || statusValue === "all" ? statusValue : "unseen";
    const sort = sortValue === "oldest" ? "oldest" : "newest";
    const page = Math.max(1, Number(url.searchParams.get("page")) || 1);
    const rawThread = url.searchParams.get("thread");
    const threadId = rawThread && rawThread !== "all" && Number.isSafeInteger(Number(rawThread))
      ? Number(rawThread)
      : undefined;
    sendJson(
      response,
      200,
      database.queryJobs({
        status,
        sort,
        page,
        threadId,
        fromUtc: validIso(url.searchParams.get("fromUtc")),
        toUtc: validIso(url.searchParams.get("toUtc")),
      }),
    );
    return;
  }

  const seenMatch = pathname.match(/^\/api\/jobs\/(\d+)\/seen$/);
  if (request.method === "PATCH" && seenMatch) {
    const body = await readJson(request);
    if (typeof body.seen !== "boolean") {
      sendError(response, 400, "INVALID_SEEN", "The seen value must be true or false.");
      return;
    }
    const updated = database.setSeen(Number(seenMatch[1]), body.seen);
    if (!updated) {
      sendError(response, 404, "JOB_NOT_FOUND", "Job not found.");
      return;
    }
    sendJson(response, 200, { id: Number(seenMatch[1]), seen: body.seen });
    return;
  }

  if (pathname.startsWith("/api/")) {
    sendError(response, 404, "NOT_FOUND", "API endpoint not found.");
    return;
  }
  await serveStatic(pathname, response);
}

const server = createServer((request, response) => {
  route(request, response).catch((error) => {
    console.error("[server] request failed", error);
    if (!response.headersSent) sendError(response, 500, "INTERNAL_ERROR", "Something went wrong.");
    else response.end();
  });
});

server.listen(config.port, config.hostname, () => {
  console.info(`HN Job Fetcher running at http://${config.hostname}:${config.port}`);
  console.info("Fetching runs only while this process is running.");
  syncService.start();
});

async function shutdown(): Promise<void> {
  console.info("\nShutting down…");
  await syncService.stop();
  for (const client of eventClients) client.end();
  server.close(() => {
    database.close();
    process.exit(0);
  });
}

process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
