import { DatabaseSync } from "node:sqlite";
import type { ParsedJob, SyncSummary, ThreadRecord } from "./types.ts";

type JobInput = ParsedJob & {
  hnId: number;
  threadHnId: number;
  author: string;
  postedAt: string;
  originalUrl: string;
};

export class AppDatabase {
  readonly connection: DatabaseSync;

  constructor(path: string) {
    this.connection = new DatabaseSync(path);
    this.connection.exec("PRAGMA foreign_keys = ON");
    this.connection.exec("PRAGMA journal_mode = WAL");
    this.migrate();
  }

  private migrate(): void {
    this.connection.exec(`
      CREATE TABLE IF NOT EXISTS threads (
        hn_id INTEGER PRIMARY KEY,
        url TEXT NOT NULL UNIQUE,
        title TEXT NOT NULL,
        is_active INTEGER NOT NULL DEFAULT 0 CHECK (is_active IN (0, 1)),
        activated_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        last_sync_started_at TEXT,
        last_successful_sync_at TEXT,
        last_sync_status TEXT NOT NULL DEFAULT 'never',
        last_sync_error TEXT
      );

      CREATE UNIQUE INDEX IF NOT EXISTS one_active_thread
      ON threads(is_active) WHERE is_active = 1;

      CREATE TABLE IF NOT EXISTS jobs (
        hn_id INTEGER PRIMARY KEY,
        thread_hn_id INTEGER NOT NULL REFERENCES threads(hn_id),
        author TEXT NOT NULL,
        posted_at TEXT NOT NULL,
        original_url TEXT NOT NULL,
        raw_html TEXT NOT NULL,
        sanitized_html TEXT NOT NULL,
        plain_text TEXT NOT NULL,
        title_text TEXT NOT NULL,
        content_html TEXT NOT NULL,
        content_preview_html TEXT NOT NULL,
        company TEXT,
        roles_json TEXT NOT NULL DEFAULT '[]',
        location_text TEXT,
        technologies_json TEXT NOT NULL DEFAULT '[]',
        seen_at TEXT,
        imported_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS jobs_posted_at ON jobs(posted_at);
      CREATE INDEX IF NOT EXISTS jobs_seen_at ON jobs(seen_at);
      CREATE INDEX IF NOT EXISTS jobs_thread_hn_id ON jobs(thread_hn_id);

      CREATE TABLE IF NOT EXISTS thread_children (
        hn_id INTEGER PRIMARY KEY,
        thread_hn_id INTEGER NOT NULL REFERENCES threads(hn_id),
        disposition TEXT NOT NULL CHECK (disposition IN ('imported', 'skipped')),
        skip_reason TEXT,
        processed_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS thread_children_thread ON thread_children(thread_hn_id);

      CREATE TABLE IF NOT EXISTS sync_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        thread_hn_id INTEGER NOT NULL REFERENCES threads(hn_id),
        started_at TEXT NOT NULL,
        finished_at TEXT,
        status TEXT NOT NULL,
        candidate_count INTEGER NOT NULL DEFAULT 0,
        new_count INTEGER NOT NULL DEFAULT 0,
        imported_count INTEGER NOT NULL DEFAULT 0,
        skipped_count INTEGER NOT NULL DEFAULT 0,
        failed_count INTEGER NOT NULL DEFAULT 0,
        error_summary TEXT
      );
    `);
  }

  close(): void {
    this.connection.close();
  }

  getActiveThread(): ThreadRecord | undefined {
    return this.connection.prepare("SELECT * FROM threads WHERE is_active = 1").get() as ThreadRecord | undefined;
  }

  getThreads(): ThreadRecord[] {
    return this.connection
      .prepare("SELECT * FROM threads ORDER BY is_active DESC, activated_at DESC")
      .all() as ThreadRecord[];
  }

  activateThread(thread: { id: number; url: string; title: string }): ThreadRecord {
    const now = new Date().toISOString();
    this.connection.exec("BEGIN IMMEDIATE");
    try {
      this.connection.prepare("UPDATE threads SET is_active = 0 WHERE is_active = 1").run();
      this.connection
        .prepare(`
          INSERT INTO threads (hn_id, url, title, is_active, activated_at, created_at)
          VALUES (?, ?, ?, 1, ?, ?)
          ON CONFLICT(hn_id) DO UPDATE SET
            url = excluded.url,
            title = excluded.title,
            is_active = 1,
            activated_at = excluded.activated_at
        `)
        .run(thread.id, thread.url, thread.title, now, now);
      this.connection.exec("COMMIT");
    } catch (error) {
      this.connection.exec("ROLLBACK");
      throw error;
    }
    return this.getActiveThread()!;
  }

  startSyncRun(threadId: number): number {
    const now = new Date().toISOString();
    this.connection
      .prepare(`
        UPDATE threads
        SET last_sync_started_at = ?, last_sync_status = 'syncing', last_sync_error = NULL
        WHERE hn_id = ?
      `)
      .run(now, threadId);
    const result = this.connection
      .prepare("INSERT INTO sync_runs (thread_hn_id, started_at, status) VALUES (?, ?, 'running')")
      .run(threadId, now);
    return Number(result.lastInsertRowid);
  }

  finishSyncRun(
    runId: number,
    threadId: number,
    status: "success" | "partial" | "failed" | "cancelled",
    summary: SyncSummary,
    error: string | null,
  ): void {
    const now = new Date().toISOString();
    this.connection.exec("BEGIN IMMEDIATE");
    try {
      this.connection
        .prepare(`
          UPDATE sync_runs SET finished_at = ?, status = ?, candidate_count = ?, new_count = ?,
            imported_count = ?, skipped_count = ?, failed_count = ?, error_summary = ?
          WHERE id = ?
        `)
        .run(
          now,
          status,
          summary.candidateCount,
          summary.newCount,
          summary.importedCount,
          summary.skippedCount,
          summary.failedCount,
          error,
          runId,
        );
      this.connection
        .prepare(`
          UPDATE threads SET
            last_sync_status = ?,
            last_sync_error = ?,
            last_successful_sync_at = CASE WHEN ? = 'success' THEN ? ELSE last_successful_sync_at END
          WHERE hn_id = ?
        `)
        .run(status, error, status, now, threadId);
      this.connection.exec("COMMIT");
    } catch (transactionError) {
      this.connection.exec("ROLLBACK");
      throw transactionError;
    }
  }

  getLatestSyncRun(threadId: number): Record<string, unknown> | undefined {
    return this.connection
      .prepare("SELECT * FROM sync_runs WHERE thread_hn_id = ? ORDER BY id DESC LIMIT 1")
      .get(threadId) as Record<string, unknown> | undefined;
  }

  getProcessedChildIds(threadId: number): Set<number> {
    const rows = this.connection
      .prepare("SELECT hn_id FROM thread_children WHERE thread_hn_id = ?")
      .all(threadId) as Array<{ hn_id: number }>;
    return new Set(rows.map((row) => row.hn_id));
  }

  insertJob(job: JobInput): boolean {
    const now = new Date().toISOString();
    this.connection.exec("BEGIN IMMEDIATE");
    try {
      const result = this.connection
        .prepare(`
          INSERT OR IGNORE INTO jobs (
            hn_id, thread_hn_id, author, posted_at, original_url, raw_html, sanitized_html,
            plain_text, title_text, content_html, content_preview_html, company, roles_json,
            location_text, technologies_json, imported_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `)
        .run(
          job.hnId,
          job.threadHnId,
          job.author,
          job.postedAt,
          job.originalUrl,
          job.rawHtml,
          job.sanitizedHtml,
          job.plainText,
          job.titleText,
          job.contentHtml,
          job.contentPreviewHtml,
          job.company,
          JSON.stringify(job.roles),
          job.locationText,
          JSON.stringify(job.technologies),
          now,
        );
      this.connection
        .prepare(`
          INSERT OR IGNORE INTO thread_children
            (hn_id, thread_hn_id, disposition, processed_at)
          VALUES (?, ?, 'imported', ?)
        `)
        .run(job.hnId, job.threadHnId, now);
      this.connection.exec("COMMIT");
      return result.changes > 0;
    } catch (error) {
      this.connection.exec("ROLLBACK");
      throw error;
    }
  }

  skipChild(threadId: number, childId: number, reason: string): void {
    this.connection
      .prepare(`
        INSERT OR IGNORE INTO thread_children
          (hn_id, thread_hn_id, disposition, skip_reason, processed_at)
        VALUES (?, ?, 'skipped', ?, ?)
      `)
      .run(childId, threadId, reason, new Date().toISOString());
  }

  setSeen(jobId: number, seen: boolean): boolean {
    const result = this.connection
      .prepare("UPDATE jobs SET seen_at = ? WHERE hn_id = ?")
      .run(seen ? new Date().toISOString() : null, jobId);
    return result.changes > 0;
  }

  queryJobs(input: {
    status: "unseen" | "seen" | "all";
    threadId?: number;
    fromUtc?: string;
    toUtc?: string;
    sort: "newest" | "oldest";
    page: number;
    pageSize?: number;
  }): { jobs: Record<string, unknown>[]; total: number; page: number; pageSize: number; totalPages: number } {
    const where: string[] = [];
    const parameters: Array<string | number> = [];
    if (input.status === "unseen") where.push("j.seen_at IS NULL");
    if (input.status === "seen") where.push("j.seen_at IS NOT NULL");
    if (input.threadId) {
      where.push("j.thread_hn_id = ?");
      parameters.push(input.threadId);
    }
    if (input.fromUtc) {
      where.push("j.posted_at >= ?");
      parameters.push(input.fromUtc);
    }
    if (input.toUtc) {
      where.push("j.posted_at < ?");
      parameters.push(input.toUtc);
    }
    const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const direction = input.sort === "oldest" ? "ASC" : "DESC";
    const pageSize = input.pageSize || 50;
    const totalRow = this.connection
      .prepare(`SELECT COUNT(*) AS total FROM jobs j ${clause}`)
      .get(...parameters) as { total: number };
    const total = Number(totalRow.total);
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const page = Math.min(Math.max(1, input.page), totalPages);
    const rows = this.connection
      .prepare(`
        SELECT j.*, t.title AS thread_title, t.is_active AS thread_is_active
        FROM jobs j JOIN threads t ON t.hn_id = j.thread_hn_id
        ${clause}
        ORDER BY j.posted_at ${direction}, j.hn_id ${direction}
        LIMIT ? OFFSET ?
      `)
      .all(...parameters, pageSize, (page - 1) * pageSize) as Record<string, unknown>[];
    const jobs = rows.map((row) => ({
      ...row,
      roles: JSON.parse(String(row.roles_json)),
      technologies: JSON.parse(String(row.technologies_json)),
      roles_json: undefined,
      technologies_json: undefined,
      raw_html: undefined,
      sanitized_html: undefined,
      content_html: undefined,
      plain_text: undefined,
    }));
    return { jobs, total, page, pageSize, totalPages };
  }
}
