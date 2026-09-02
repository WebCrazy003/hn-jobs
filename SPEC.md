# HN Job Fetcher — Product and Technical Specification

Status: Draft for implementation  
Version: 1.0 (MVP)  
Last updated: 2026-09-02

## 1. Product summary

HN Job Fetcher is a local, single-user web application for following Hacker News monthly “Who is hiring?” threads. The user manually configures the current thread. While the local application process is running, it imports newly added top-level job comments every five minutes and presents all imported jobs, regardless of month, in one filterable and paginated list.

The application is a reader and tracker. It never posts, votes, or writes data to Hacker News.

## 2. Goals

- Let the user set exactly one active “Who is hiring?” HN thread from a Settings page.
- Import all existing top-level job comments when a valid thread is activated.
- Check the active thread for new top-level job comments immediately at application startup and every five minutes afterward.
- Preserve jobs and seen/unseen state across application restarts and monthly thread changes.
- Make long, inconsistently formatted HN job posts easy to scan.
- Let the user filter by seen status and posting date, and sort by posting date.
- Provide a direct link to each original HN comment.

## 3. Non-goals for MVP

- Automatically discovering the new monthly thread.
- Importing “Who wants to be hired?” or standalone HN job submissions.
- Importing replies beneath job comments.
- Applying to jobs, saving notes, favorites, full-text search, alerts, email, or accounts.
- Perfect semantic extraction of company, roles, location, or technologies.
- Editing or deleting HN content.
- Hosting the application publicly, multi-user authentication, or synchronization between multiple installations.

## 4. Definitions and product decisions

### Active thread

The one HN story currently checked for new jobs. The user changes it manually in Settings.

### Job

A direct child comment of the configured thread. Nested replies are not jobs, even when they contain job-like text. A job is uniquely identified by its HN item ID.

### Job title

The first visible line/block of a top-level comment, after decoding and sanitizing the HN HTML. The complete first line is retained exactly as visible text and is the prominent heading on the card.

### Job content

Everything after the first visible line/block. A card displays no more than the first 200 whitespace-delimited words of this content. If content is truncated, it ends with an ellipsis. MVP has no in-card expansion; the original post is the source for the full text.

### New and seen

- **New/unseen:** the user has not marked the job as seen.
- **Seen:** the user has checked the Seen control. This is local application state and does not affect HN.
- “New” is not based on the most recent sync time. It means `seen_at` is empty.

### Historical jobs

Changing the active thread does not remove previously imported threads or jobs. The Jobs page can show jobs from all imported threads. Only the active thread continues to receive updates.

## 5. Primary user flows

### 5.1 First run

1. The user opens the application.
2. With no active thread, the Jobs page shows an empty state and a link to Settings.
3. In Settings, the user pastes an HN item URL such as `https://news.ycombinator.com/item?id=49522897`.
4. The application validates the URL and thread through the HN API.
5. On success, the application saves it as active and immediately starts an initial import.
6. The UI reports sync progress and then shows the imported jobs.

### 5.2 Ongoing sync

1. On server start, the application immediately syncs the saved active thread.
2. Five minutes after a sync starts, it starts the next scheduled sync, provided another sync is not still running.
3. The application fetches the active story, compares its direct child IDs with locally processed child IDs, and fetches only missing items.
4. After new jobs commit locally, the server emits a `jobs-imported` event. An open Jobs page automatically refreshes its current result set from the local application API; it must not fetch HN directly.
5. When the user is on page 1, newly imported jobs that match the active filters appear at the correct sorted position. On later pages, the page does not jump; a **New jobs available** notice lets the user return to page 1.

### 5.3 Monthly rollover

1. The user pastes the new monthly thread URL in Settings.
2. The application validates the candidate while the current thread remains active.
3. After successful validation, the application aborts and waits for any old-thread sync to stop.
4. The new thread then becomes active atomically and the previous one becomes inactive.
5. An initial import for the new active thread begins immediately.
6. Existing historical jobs and seen state remain available.

### 5.4 Marking a job seen

1. An unseen card displays an unchecked **Seen** control.
2. Checking it removes the card from an Unseen result list immediately using an optimistic update, then persists `seen_at`.
3. A short **Undo** notice lets the user reverse the action. If persistence fails, the card is restored and an error is shown.
4. In “All” or “Seen,” the user may uncheck the control to mark the job unseen again.

### 5.5 Opening the source

Selecting **Open original post** opens `https://news.ycombinator.com/item?id=<job_id>` in a new browser tab with safe `noopener,noreferrer` behavior.

## 6. Functional requirements

### 6.1 Settings page

The page contains:

- Active thread URL input.
- **Save and sync** button.
- Active thread title and canonical HN URL, when configured.
- Last successful sync time.
- Current sync activity: `idle` or `syncing`.
- Last sync result: `never`, `success`, `partial`, `failed`, or `cancelled`.
- Last sync summary: number discovered, number imported, and number failed.
- A concise error message and retry action after failure.

Validation rules:

- Trim surrounding whitespace.
- Accept only HTTPS URLs with host `news.ycombinator.com`, path `/item`, and one positive integer `id` query value. Ignore unrelated query parameters.
- Canonicalize a valid value to `https://news.ycombinator.com/item?id=<id>`.
- Fetch the item before activating it.
- Require an existing, non-deleted, non-dead item of type `story` whose title contains “Who is hiring?” case-insensitively. The leading “Ask HN:” and month/year text are optional.
- Do not replace the existing active thread when validation fails.
- Re-saving the already active URL is allowed and triggers a sync.

Only one thread may be active at a time.

### 6.2 Fetch scheduler

- Run in the server process, independent of open browser tabs.
- When the server starts, trigger one sync immediately if an active thread exists.
- After activation or re-saving, trigger one sync immediately.
- While the process remains alive, schedule a sync every five minutes.
- Never run two syncs concurrently. If a scheduled tick occurs during a sync, skip that tick; do not queue an accumulating backlog.
- When a different valid thread is activated, cooperatively cancel the old thread’s in-flight network requests and wait for that sync to stop before starting the new thread sync. Already committed old-thread jobs remain valid, but no further old-thread work may commit after cancellation.
- Give each sync an immutable thread ID and cancellation/generation token. A cancelled or stale sync may update only its own `sync_runs` record; it must never overwrite status belonging to the newly active thread.
- Use UTC for stored timestamps.
- A process restart resets the timer but not imported data or user state.
- Fetching occurs only while the local project process is running. The UI must state this clearly; no operating-system background service is required.

### 6.3 HN data source and import algorithm

Use the official Hacker News API as the primary source rather than scraping page markup:

- Story/comment endpoint: `https://hacker-news.firebaseio.com/v0/item/<id>.json`
- The configured story’s `kids` array is the candidate set of direct comments.
- Fetch a child only if its ID is not already recorded as an imported job or a terminally skipped child for that thread. Failed lookups are not recorded as processed and are retried later.
- Import only items where `type == "comment"`, `parent == <active_thread_id>`, `text` is non-empty, and neither `deleted` nor `dead` is true.
- Never traverse a child comment’s `kids`; those are replies.
- Upsert by HN job ID so restarts and repeated fetches cannot create duplicates.
- Preserve the HN `time` value as the job’s posted time. Import time is separate.
- Do not derive ordering from the story’s `kids` order because HN may rank comments. Use the comment timestamp.
- Treat an absent/null `kids` list as an empty thread, not as a fatal error.

Import resilience:

- Apply a finite request timeout and retry transient network/5xx failures with bounded exponential backoff.
- Limit child fetch concurrency to avoid a request burst during the initial import. A default of 10 concurrent requests is acceptable.
- Failure to fetch one child must not discard successfully imported siblings.
- Record the failed child count and IDs for observability and retry missing IDs in future syncs.
- Only update `last_successful_sync_at` when the story and every required child were processed without a fetch/import failure. A run with one or more individual child failures is `partial`; a failure to fetch the story marks the whole run `failed`.
- Keep previously imported job data when HN is unavailable.

MVP does not refresh already imported comments after their first successful import. Edits or later deletion on HN therefore do not alter the local copy.

### 6.4 Parsing and normalization

HN comment `text` is HTML. Parsing must occur on the server.

1. Sanitize against an allowlist before rendering. Scripts, event handlers, unsafe URL schemes, and arbitrary attributes must never reach the browser.
2. Preserve safe paragraph breaks, line breaks, lists, emphasis, code, and HTTPS/HTTP links in the content preview.
3. Determine the title from the first visible block/line. If the post has no break, the complete visible text is the title and content is empty.
4. Remove the title portion from the content before calculating the 200-word preview.
5. Count words from visible text, splitting on whitespace; HTML tags do not count. Preserve valid markup while truncating, and always close tags correctly.
6. Store both the sanitized full content and a plain-text representation so parsing can be improved later without re-fetching.

Structured highlights are best-effort and may be empty:

- Split the title on pipe (`|`) separators.
- Treat the first segment as the company label when present.
- Extract the location/work-arrangement segment as written rather than forcing it into one exclusive remote/onsite/hybrid enum. Detect explicit terms such as `REMOTE`, `ONSITE`, `ON-SITE`, and `HYBRID` case-insensitively and preserve the complete matching segment, including mixed options and restrictions such as `Toronto, Canada or REMOTE` and `REMOTE (US)`.
- Extract likely role/title segments without rewriting the original title. First inspect pipe-separated title segments containing role terms such as Engineer, Developer, Designer, Product, Data, Scientist, Manager, or Member of Technical Staff.
- Also inspect body lines beginning with deterministic labels such as `Hiring:`, `Roles:`, `Open roles:`, `Open positions:`, or `Positions:`. Split their value on commas, semicolons, bullets, or clearly separated links and keep entries matching the role-term dictionary. Cap displayed role chips at eight, with `+N` for the remainder.
- Detect technology names case-insensitively across the complete title and job content using a maintained alias dictionary. The MVP seed dictionary must include at least TypeScript, JavaScript, Python, Go, Rust, Java, C#, C++, React, Vue, Angular, Node.js, Postgres/PostgreSQL, MySQL, Redis, AWS, GCP, Azure, Docker, Kubernetes, Terraform, PyTorch, TensorFlow, and Cloudflare Workers. Deduplicate canonical labels and cap displayed technology chips at eight, with `+N` for the remainder.
- Never invent a structured value when confidence is low. The exact original title remains visible, so parser failure does not hide information.

Parsing is deterministic in MVP; no LLM or external enrichment service is required.

### 6.5 Jobs page

The page header contains:

- Page title.
- Visible-result count.
- Active thread label.
- Last successful sync time and current sync state.
- Link to Settings.

Default list state:

- Seen-status filter: **Unseen**.
- Thread filter: **All imported threads**.
- Date range: unset.
- Sort: **Posted date — newest first**.

Filters and sorting:

- Seen status: `Unseen`, `Seen`, or `All` (single selection).
- Posted date from and to (either may be empty). Interpret dates in the browser’s local timezone and make both boundaries inclusive calendar dates. The client sends the corresponding UTC start/end instants or its IANA timezone with the request; the server must not guess its own timezone.
- Thread/month: all imported threads or one selected thread, including the active/inactive status in the option label. **All imported threads** remains the default, so changing months never hides older jobs automatically.
- Sort: posted date `Newest first` or `Oldest first`.
- Apply filters together with AND semantics.
- Sorting must be deterministic: break equal posted timestamps by HN item ID, descending for newest and ascending for oldest.
- Keep filters in URL query parameters so refresh/back navigation preserves the view.
- Provide **Clear filters**, which restores all defaults.

Pagination:

- Use server-side pagination with 50 jobs per page.
- Reset to page 1 when a filter or sort value changes.
- New imports must not silently move the user away from the page they are viewing.
- “All jobs” means every imported job is stored and reachable through pagination; it does not mean rendering every card on one page.

Empty states must distinguish:

- No active thread configured.
- Active thread exists but no jobs have been imported.
- No jobs match the current filters.
- Sync failed and cached jobs are still being shown.

### 6.6 Job card

Every card displays:

- Exact first-line title, visually prominent.
- Best-effort chips for role/title, location/work mode, and technology stack.
- HN author.
- Relative posted time such as “18 minutes ago,” based on HN’s timestamp, plus the exact local date/time in a tooltip or accessible label.
- Up to 200 words of content after the title.
- Source thread/month label so historical jobs have context.
- Checkable **Seen** control.
- **Open original post** link/button.

The relative time updates while the page is open without requiring a refetch. All controls must have visible keyboard focus and accessible names. Chip color cannot be the only way information type is communicated.

## 7. Data model

The implementation may use SQLite for the single-user MVP. Required logical fields follow; exact ORM names may differ.

### `threads`

| Field | Type | Constraints / meaning |
| --- | --- | --- |
| `hn_id` | integer | Primary key; HN story ID |
| `url` | text | Canonical HN URL; unique |
| `title` | text | HN story title |
| `is_active` | boolean | Exactly zero or one row true |
| `activated_at` | timestamp UTC | Most recent activation |
| `created_at` | timestamp UTC | First local save |
| `last_sync_started_at` | timestamp UTC, nullable | Latest attempt start |
| `last_successful_sync_at` | timestamp UTC, nullable | Latest successful run |
| `last_sync_status` | enum | `never`, `syncing`, `success`, `partial`, `failed`, `cancelled` |
| `last_sync_error` | text, nullable | Safe summary, no stack trace/secrets |

### `jobs`

| Field | Type | Constraints / meaning |
| --- | --- | --- |
| `hn_id` | integer | Primary key; HN comment ID |
| `thread_hn_id` | integer | Foreign key to `threads.hn_id`; indexed |
| `author` | text | HN `by`, with fallback `unknown` |
| `posted_at` | timestamp UTC | HN `time`; indexed |
| `original_url` | text | Canonical comment URL |
| `raw_html` | text | Original API text for reparsing; never render directly |
| `sanitized_html` | text | Sanitized full post |
| `plain_text` | text | Visible full post text |
| `title_text` | text | First visible line/block |
| `content_html` | text | Sanitized content after title |
| `content_preview_html` | text | Safe 200-word preview |
| `company` | text, nullable | Best-effort extraction |
| `roles_json` | JSON/text | Canonical display strings |
| `location_text` | text, nullable | Includes remote restrictions when present |
| `technologies_json` | JSON/text | Deduplicated canonical labels |
| `seen_at` | timestamp UTC, nullable | Null means unseen; indexed |
| `imported_at` | timestamp UTC | First successful local import |

### `thread_children`

This processing ledger prevents permanently invalid/deleted direct children from being fetched every five minutes. Failed lookups are deliberately absent so they remain retryable.

| Field | Type | Constraints / meaning |
| --- | --- | --- |
| `hn_id` | integer | Primary key; direct child item ID |
| `thread_hn_id` | integer | Foreign key to `threads.hn_id`; indexed |
| `disposition` | enum | `imported` or `skipped` |
| `skip_reason` | text, nullable | For example `deleted`, `dead`, `empty`, or `not_comment` |
| `processed_at` | timestamp UTC | Successful terminal processing time |

An imported ledger row and its corresponding `jobs` row must be committed in the same transaction.

### `sync_runs`

| Field | Type | Constraints / meaning |
| --- | --- | --- |
| `id` | integer/UUID | Primary key |
| `thread_hn_id` | integer | Thread synced |
| `started_at` | timestamp UTC | Attempt start |
| `finished_at` | timestamp UTC, nullable | Attempt finish |
| `status` | enum | `running`, `success`, `partial`, `failed`, `cancelled` |
| `candidate_count` | integer | Direct child IDs in story response |
| `new_count` | integer | IDs missing locally |
| `imported_count` | integer | Valid jobs added |
| `skipped_count` | integer | Invalid/deleted/dead/empty children |
| `failed_count` | integer | Child fetch/import failures |
| `error_summary` | text, nullable | Diagnostic summary |

Database constraints or a transaction must enforce a single active thread. Activating a thread and deactivating the previous thread must be atomic.

## 8. Internal application API

Exact framework conventions may vary, but the UI needs equivalent operations:

- `GET /api/settings` — active thread and sync state.
- `PUT /api/settings/active-thread` with `{ "url": "..." }` — validate, atomically activate, and request immediate sync.
- `POST /api/sync` — manually retry the active thread; return conflict/current status if a sync is running.
- `GET /api/jobs?status=unseen|seen|all&from=YYYY-MM-DD&to=YYYY-MM-DD&tz=<IANA-timezone>&thread=<id|all>&sort=newest|oldest&page=<n>` — filtered, paginated jobs and total. An implementation may instead send already converted UTC range instants.
- `PATCH /api/jobs/<id>/seen` with `{ "seen": true|false }` — idempotently update local seen state.
- `GET /api/events` — local Server-Sent Events stream. Emit `jobs-imported` only after a successful database commit, with thread ID and imported count; emit no job content in the event.

Mutations must validate input server-side. Error responses use a stable machine code and a safe user-facing message.

## 9. Error behavior

- Invalid URL: explain the accepted HN item URL format inline.
- Valid HN URL but wrong item: state that it is not a live “Who is hiring?” story.
- HN unavailable during Settings validation: do not change the active thread; allow retry.
- Scheduled sync failure: keep cached jobs usable, show a non-blocking warning, and automatically retry on the next interval.
- Partial child failure: import successful jobs, label the run partial, and retry missing IDs on the next interval.
- Active-thread replacement: mark the stopped run `cancelled`; cancellation is expected behavior, not a sync error.
- Database write failure: do not report a job as imported or seen until its transaction commits.
- Duplicate child IDs or repeated sync requests: produce one stored job per HN item ID.

## 10. Security and privacy

- HN content is untrusted input. Sanitize server-side and never render `raw_html`.
- Allow only `http:` and `https:` href schemes; external links open safely.
- Do not fetch arbitrary user-supplied hosts. Settings validation must enforce the exact HN hostname before any network request, preventing SSRF.
- No HN login or API credential is needed.
- Store only public HN content and local seen state.
- Do not send job text to third-party enrichment or analytics services in MVP.

## 11. Performance and reliability targets

- After data is local, the first Jobs page should respond in under 500 ms for 2,000 stored jobs on a typical development machine.
- A newly posted job should normally be imported within five minutes plus network/runtime latency while the server is continuously running.
- Initial import must be restart-safe and idempotent.
- The application must remain usable from cached data during an HN outage.
- Log sync start/end, thread ID, counts, duration, and safe error summaries. Do not log full job bodies by default.

## 12. Acceptance criteria

### Thread configuration

- Given no configured thread, when a valid monthly HN URL is saved, then it becomes the only active thread and an import starts immediately.
- Given an existing active thread, when an invalid or unreachable replacement is submitted, then the existing active thread remains unchanged.
- Given a second valid monthly thread, when it is saved, then old jobs remain stored and only the second thread is polled afterward.

### Fetching

- Given an active thread at server startup, an HN fetch begins without waiting five minutes.
- Given a successful sync, another check is attempted approximately every five minutes while the process runs.
- Given a top-level comment not in the database, the next successful sync imports it once.
- Given a nested reply, no sync imports it as a job.
- Given repeated story responses containing the same child ID, no duplicate job is created.
- Given one failed child request among successful requests, successful siblings are saved and the failed ID is retried later.

### Parsing and display

- Given the LatchBio sample, the exact first line is the card heading; `ONSITE`/San Francisco and recognizable technologies/roles are highlighted when detected.
- Given the Cardog sample, the heading is its first line; `Toronto, Canada or REMOTE` is preserved as the location/work-arrangement highlight; VIN Decode Engineer, Data Platform Engineer, Infrastructure Engineer, and Founding Engineer are extracted from the `Hiring:` body line; and TypeScript, Postgres, and Cloudflare Workers are extracted from the job content as technology chips.
- Given body content over 200 words, no more than 200 visible body words appear on its card and the HTML remains valid.
- Given malicious HTML in an HN comment, executable content is absent from the rendered page.
- Every job’s original-post action points to its own HN comment ID, not the monthly thread ID.

### Seen state, filters, and sort

- On first visit, unseen jobs from all imported threads are shown newest first.
- Marking an unseen job seen removes it from the default view optimistically and, after the write succeeds, persists across refresh/restart.
- Marking a job seen removes it from an Unseen list immediately; Undo reverses it, and a failed write restores the card.
- Selecting Seen shows only seen jobs; selecting All shows both.
- Date boundaries include jobs posted anywhere on the selected local calendar dates.
- Newest and oldest sort orders use HN posting time and have deterministic item-ID tie-breaking.
- Filter/sort state survives a browser refresh through URL query parameters.
- Given an open page 1, newly committed matching jobs appear automatically in the correct order without a full browser reload.
- Given an open later page, a new import does not change the page and instead displays a New jobs available notice.

## 13. Test strategy

- Unit tests for URL parsing/canonicalization, title/body splitting, HTML sanitization, 200-word truncation, title/body role extraction, technology extraction, relative-time boundaries, and filter query parsing.
- Import service tests with recorded API-shaped fixtures for empty threads, new children, duplicates, nested replies, deleted/dead items, partial failures, and retries.
- Database tests for atomic active-thread switching, idempotent upsert, and seen-state persistence.
- Scheduler tests using a fake clock for immediate startup sync, five-minute ticks, overlap prevention, cancellation, and stale-sync write prevention.
- UI tests for default filters, date inclusivity, sorting, pagination, empty/error states, optimistic Seen/Undo behavior, live import events, keyboard access, and original links.
- End-to-end test using a stub HN API; automated tests must not depend on live HN availability.

## 14. Recommended implementation shape

This section is guidance, not a user-visible requirement:

- A local server-rendered TypeScript web application with a persistent server process, bound to loopback by default.
- SQLite plus migrations for local durable storage.
- A single in-process scheduler guarded by a mutex for the MVP deployment model.
- A server-side HN client, parser/sanitizer module, import service, and database repository kept as separate components.
- A local Server-Sent Events endpoint to notify open pages after imports commit.

## 15. Confirmed implementation decisions

These decisions are approved for the MVP:

1. The application runs locally for one user, requires no authentication, and fetches only while the project process is running.
2. Historical jobs remain available after changing months; all months are shown together by default, and only the selected thread is active for fetching.
3. “All jobs” means all imported top-level job posts are accessible through pagination, while the default view intentionally hides seen jobs.
4. The 200-word rule applies only to content after the first-line title.
5. Seen is reversible, updates the list optimistically, and immediately hides a card under the default Unseen filter.
6. Role and technology extraction is deterministic and inspects both the title and labeled/body content; location/work arrangement is preserved as written.
7. Empty, dead, deleted, or otherwise skipped child items are not revisited. Only newly added, previously unprocessed child IDs are fetched.
8. Previously imported HN comments are immutable locally; later HN edits/deletions are not synchronized in MVP.

## 16. References

- Example active thread supplied for this project: <https://news.ycombinator.com/item?id=49522897>
- Official Hacker News API documentation: <https://github.com/HackerNews/API>
