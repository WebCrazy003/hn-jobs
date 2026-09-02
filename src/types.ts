export type HnItem = {
  id: number;
  type?: "story" | "comment" | "job" | "poll" | "pollopt";
  by?: string;
  time?: number;
  text?: string;
  title?: string;
  parent?: number;
  kids?: number[];
  deleted?: boolean;
  dead?: boolean;
};

export type ParsedJob = {
  rawHtml: string;
  sanitizedHtml: string;
  plainText: string;
  titleText: string;
  contentHtml: string;
  contentPreviewHtml: string;
  company: string | null;
  roles: string[];
  locationText: string | null;
  technologies: string[];
};

export type ThreadRecord = {
  hn_id: number;
  url: string;
  title: string;
  is_active: number;
  activated_at: string;
  created_at: string;
  last_sync_started_at: string | null;
  last_successful_sync_at: string | null;
  last_sync_status: string;
  last_sync_error: string | null;
};

export type SyncSummary = {
  candidateCount: number;
  newCount: number;
  importedCount: number;
  skippedCount: number;
  failedCount: number;
};
