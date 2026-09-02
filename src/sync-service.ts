import { AppDatabase } from "./database.ts";
import { HnClient } from "./hn-client.ts";
import { parseJobPost } from "./parser.ts";
import type { HnItem, SyncSummary, ThreadRecord } from "./types.ts";

type EventPublisher = (event: string, data: Record<string, unknown>) => void;

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function isCancelled(signal: AbortSignal, error: unknown): boolean {
  return signal.aborted || (error instanceof Error && error.name === "AbortError");
}

function terminalSkipReason(item: HnItem | null, threadId: number): string | null {
  if (!item) return "missing";
  if (item.deleted) return "deleted";
  if (item.dead) return "dead";
  if (item.type !== "comment") return "not_comment";
  if (item.parent !== threadId) return "wrong_parent";
  if (!item.text?.trim()) return "empty";
  return null;
}

export class SyncService {
  private readonly database: AppDatabase;
  private readonly hnClient: HnClient;
  private readonly intervalMs: number;
  private readonly concurrency: number;
  private readonly publish: EventPublisher;
  private timer: NodeJS.Timeout | null = null;
  private activeController: AbortController | null = null;
  private activePromise: Promise<void> | null = null;

  constructor(options: {
    database: AppDatabase;
    hnClient: HnClient;
    intervalMs: number;
    concurrency: number;
    publish: EventPublisher;
  }) {
    this.database = options.database;
    this.hnClient = options.hnClient;
    this.intervalMs = options.intervalMs;
    this.concurrency = Math.max(1, options.concurrency);
    this.publish = options.publish;
  }

  start(): void {
    if (this.timer) return;
    this.requestSync("startup");
    this.timer = setInterval(() => this.requestSync("scheduled"), this.intervalMs);
  }

  requestSync(reason: "startup" | "scheduled" | "activation" | "manual"): boolean {
    if (this.activePromise || !this.database.getActiveThread()) return false;
    void this.syncActive(reason);
    return true;
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.cancelCurrent();
  }

  async activateThreadUrl(url: string): Promise<ThreadRecord> {
    const validated = await this.hnClient.validateThreadUrl(url);
    const current = this.database.getActiveThread();
    if (current?.hn_id !== validated.id) await this.cancelCurrent();
    const active = this.database.activateThread(validated);
    this.requestSync("activation");
    return active;
  }

  async cancelCurrent(): Promise<void> {
    const promise = this.activePromise;
    if (!promise) return;
    this.activeController?.abort(new DOMException("Sync cancelled", "AbortError"));
    await promise.catch(() => undefined);
  }

  async syncActive(reason: "startup" | "scheduled" | "activation" | "manual"): Promise<boolean> {
    if (this.activePromise) return false;
    const thread = this.database.getActiveThread();
    if (!thread) return false;
    const controller = new AbortController();
    this.activeController = controller;
    const promise = this.runSync(thread, controller.signal, reason);
    this.activePromise = promise;
    try {
      await promise;
    } finally {
      if (this.activeController === controller) {
        this.activeController = null;
        this.activePromise = null;
      }
    }
    return true;
  }

  private async runSync(
    thread: ThreadRecord,
    signal: AbortSignal,
    reason: string,
  ): Promise<void> {
    const summary: SyncSummary = {
      candidateCount: 0,
      newCount: 0,
      importedCount: 0,
      skippedCount: 0,
      failedCount: 0,
    };
    const runId = this.database.startSyncRun(thread.hn_id);
    this.publish("sync-status", { status: "syncing", threadId: thread.hn_id, reason });
    const startedAt = Date.now();

    try {
      const story = await this.hnClient.fetchItem(thread.hn_id, signal);
      if (!story || story.type !== "story") throw new Error("The active HN thread is unavailable.");
      const candidates = story.kids || [];
      summary.candidateCount = candidates.length;
      const processed = this.database.getProcessedChildIds(thread.hn_id);
      const missing = candidates.filter((id) => !processed.has(id));
      summary.newCount = missing.length;

      let cursor = 0;
      const worker = async (): Promise<void> => {
        while (cursor < missing.length) {
          if (signal.aborted) throw signal.reason;
          const childId = missing[cursor];
          cursor += 1;
          try {
            const item = await this.hnClient.fetchItem(childId, signal);
            if (signal.aborted) throw signal.reason;
            const skipReason = terminalSkipReason(item, thread.hn_id);
            if (skipReason) {
              this.database.skipChild(thread.hn_id, childId, skipReason);
              summary.skippedCount += 1;
              continue;
            }
            const parsed = parseJobPost(item!.text!);
            if (signal.aborted) throw signal.reason;
            const inserted = this.database.insertJob({
              ...parsed,
              hnId: item!.id,
              threadHnId: thread.hn_id,
              author: item!.by || "unknown",
              postedAt: new Date((item!.time || 0) * 1000).toISOString(),
              originalUrl: `https://news.ycombinator.com/item?id=${item!.id}`,
            });
            if (inserted) summary.importedCount += 1;
          } catch (error) {
            if (isCancelled(signal, error)) throw error;
            summary.failedCount += 1;
            console.warn(`[sync] child ${childId} failed: ${errorMessage(error)}`);
          }
        }
      };

      await Promise.all(
        Array.from({ length: Math.min(this.concurrency, missing.length) }, () => worker()),
      );
      const status = summary.failedCount > 0 ? "partial" : "success";
      this.database.finishSyncRun(runId, thread.hn_id, status, summary, null);
      console.info(
        `[sync] ${status} thread=${thread.hn_id} candidates=${summary.candidateCount} new=${summary.newCount} imported=${summary.importedCount} failed=${summary.failedCount} durationMs=${Date.now() - startedAt}`,
      );
      if (summary.importedCount > 0) {
        this.publish("jobs-imported", {
          threadId: thread.hn_id,
          importedCount: summary.importedCount,
        });
      }
      this.publish("sync-status", { status, threadId: thread.hn_id, summary });
    } catch (error) {
      if (isCancelled(signal, error)) {
        this.database.finishSyncRun(runId, thread.hn_id, "cancelled", summary, null);
        console.info(`[sync] cancelled thread=${thread.hn_id} durationMs=${Date.now() - startedAt}`);
        this.publish("sync-status", { status: "cancelled", threadId: thread.hn_id });
        return;
      }
      const message = errorMessage(error);
      this.database.finishSyncRun(runId, thread.hn_id, "failed", summary, message);
      console.error(`[sync] failed thread=${thread.hn_id}: ${message}`);
      this.publish("sync-status", { status: "failed", threadId: thread.hn_id, error: message });
    }
  }
}
