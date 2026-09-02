const state = {
  settings: null,
  jobs: null,
  toastTimer: null,
};

const elements = {
  jobsView: document.querySelector("#jobs-view"),
  settingsView: document.querySelector("#settings-view"),
  jobsList: document.querySelector("#jobs-list"),
  jobsSummary: document.querySelector("#jobs-summary"),
  jobsError: document.querySelector("#jobs-error"),
  pagination: document.querySelector("#pagination"),
  syncPill: document.querySelector("#sync-pill"),
  newJobsNotice: document.querySelector("#new-jobs-notice"),
  filters: document.querySelector("#filters"),
  status: document.querySelector("#filter-status"),
  from: document.querySelector("#filter-from"),
  to: document.querySelector("#filter-to"),
  thread: document.querySelector("#filter-thread"),
  sort: document.querySelector("#filter-sort"),
  threadForm: document.querySelector("#thread-form"),
  threadUrl: document.querySelector("#thread-url"),
  threadError: document.querySelector("#thread-error"),
  saveThread: document.querySelector("#save-thread"),
  syncNow: document.querySelector("#sync-now"),
  settingsStatus: document.querySelector("#settings-status"),
  toast: document.querySelector("#toast"),
};

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { "content-type": "application/json", ...(options.headers || {}) },
  });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error?.message || body.message || "Request failed.");
  return body;
}

function showToast(message, actionLabel, action) {
  clearTimeout(state.toastTimer);
  elements.toast.replaceChildren(document.createTextNode(message));
  if (actionLabel && action) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = actionLabel;
    button.addEventListener("click", async () => {
      elements.toast.classList.add("hidden");
      await action();
    }, { once: true });
    elements.toast.append(button);
  }
  elements.toast.classList.remove("hidden");
  state.toastTimer = setTimeout(() => elements.toast.classList.add("hidden"), 5000);
}

function route() {
  const settings = window.location.pathname === "/settings";
  elements.jobsView.classList.toggle("hidden", settings);
  elements.settingsView.classList.toggle("hidden", !settings);
  document.querySelectorAll("[data-route]").forEach((link) => {
    link.classList.toggle("active", new URL(link.href).pathname === window.location.pathname);
  });
  if (settings) void loadSettings();
  else void loadJobs();
}

document.addEventListener("click", (event) => {
  const link = event.target.closest("a[data-route]");
  if (!link || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  event.preventDefault();
  history.pushState({}, "", link.href);
  route();
});
window.addEventListener("popstate", route);

function currentFilters() {
  const params = new URLSearchParams(window.location.search);
  return {
    status: ["unseen", "seen", "all"].includes(params.get("status")) ? params.get("status") : "unseen",
    from: params.get("from") || "",
    to: params.get("to") || "",
    thread: params.get("thread") || "all",
    sort: params.get("sort") === "oldest" ? "oldest" : "newest",
    page: Math.max(1, Number(params.get("page")) || 1),
  };
}

function localDateToUtc(value, nextDay = false) {
  if (!value) return null;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(year, month - 1, day + (nextDay ? 1 : 0), 0, 0, 0, 0);
  return date.toISOString();
}

function writeFilters(filters, push = true) {
  const params = new URLSearchParams();
  if (filters.status !== "unseen") params.set("status", filters.status);
  if (filters.from) params.set("from", filters.from);
  if (filters.to) params.set("to", filters.to);
  if (filters.thread !== "all") params.set("thread", filters.thread);
  if (filters.sort !== "newest") params.set("sort", filters.sort);
  if (filters.page > 1) params.set("page", String(filters.page));
  const next = `${window.location.pathname}${params.size ? `?${params}` : ""}`;
  history[push ? "pushState" : "replaceState"]({}, "", next);
}

function syncFilterControls(filters) {
  elements.status.value = filters.status;
  elements.from.value = filters.from;
  elements.to.value = filters.to;
  elements.thread.value = filters.thread;
  if (!elements.thread.value) elements.thread.value = "all";
  elements.sort.value = filters.sort;
}

function relativeTime(iso) {
  const seconds = Math.round((new Date(iso).getTime() - Date.now()) / 1000);
  const absolute = Math.abs(seconds);
  const units = [
    ["year", 31_536_000], ["month", 2_592_000], ["day", 86_400],
    ["hour", 3_600], ["minute", 60], ["second", 1],
  ];
  const [unit, size] = units.find(([, value]) => absolute >= value) || units.at(-1);
  return new Intl.RelativeTimeFormat(undefined, { numeric: "auto" }).format(Math.round(seconds / size), unit);
}

function createChip(kind, text) {
  const chip = document.createElement("span");
  chip.className = `chip ${kind}`;
  chip.textContent = text;
  return chip;
}

function appendCappedChips(container, kind, values, limit = 8) {
  values.slice(0, limit).forEach((value) => container.append(createChip(kind, value)));
  if (values.length > limit) container.append(createChip(kind, `+${values.length - limit}`));
}

function makeJobCard(job) {
  const card = document.createElement("article");
  card.className = "job-card";
  card.dataset.id = String(job.hn_id);

  const top = document.createElement("div");
  top.className = "card-top";
  const headingWrap = document.createElement("div");
  const heading = document.createElement("h2");
  heading.className = "job-title";
  heading.textContent = job.title_text;
  const meta = document.createElement("div");
  meta.className = "card-meta";
  const posted = document.createElement("time");
  posted.dateTime = job.posted_at;
  posted.title = new Date(job.posted_at).toLocaleString();
  posted.dataset.relativeTime = job.posted_at;
  posted.textContent = relativeTime(job.posted_at);
  meta.append(`by ${job.author}`, posted, job.thread_title);
  headingWrap.append(heading, meta);
  top.append(headingWrap);

  const chips = document.createElement("div");
  chips.className = "chips";
  if (job.location_text) chips.append(createChip("location", `Location · ${job.location_text}`));
  appendCappedChips(chips, "role", job.roles || []);
  appendCappedChips(chips, "tech", job.technologies || []);

  const content = document.createElement("div");
  content.className = "job-content";
  content.innerHTML = job.content_preview_html;

  const actions = document.createElement("div");
  actions.className = "card-actions";
  const seenLabel = document.createElement("label");
  seenLabel.className = "seen-control";
  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  checkbox.checked = Boolean(job.seen_at);
  checkbox.setAttribute("aria-label", `Mark ${job.title_text} as seen`);
  seenLabel.append(checkbox, document.createTextNode("Seen"));
  checkbox.addEventListener("change", () => void changeSeen(job, checkbox.checked, card));
  const original = document.createElement("a");
  original.className = "original-link";
  original.href = job.original_url;
  original.target = "_blank";
  original.rel = "noopener noreferrer";
  original.textContent = "Open original post ↗";
  actions.append(seenLabel, original);

  card.append(top);
  if (chips.childElementCount) card.append(chips);
  if (job.content_preview_html) card.append(content);
  card.append(actions);
  return card;
}

async function changeSeen(job, seen, card) {
  const filters = currentFilters();
  const leavesView = (filters.status === "unseen" && seen) || (filters.status === "seen" && !seen);
  if (leavesView) {
    card.classList.add("removing");
    setTimeout(() => card.remove(), 150);
  }
  const save = api(`/api/jobs/${job.hn_id}/seen`, {
    method: "PATCH",
    body: JSON.stringify({ seen }),
  });
  showToast(seen ? "Job marked seen." : "Job marked unseen.", "Undo", async () => {
    await save.catch(() => undefined);
    await api(`/api/jobs/${job.hn_id}/seen`, {
      method: "PATCH",
      body: JSON.stringify({ seen: !seen }),
    });
    await loadJobs();
  });
  try {
    await save;
    if (leavesView) await loadJobs();
  } catch (error) {
    showToast(error.message || "Could not update the job.");
    await loadJobs();
  }
}

function renderPagination(result) {
  elements.pagination.replaceChildren();
  if (result.totalPages <= 1) return;
  const previous = document.createElement("button");
  previous.textContent = "Previous";
  previous.disabled = result.page <= 1;
  const label = document.createElement("span");
  label.textContent = `Page ${result.page} of ${result.totalPages}`;
  const next = document.createElement("button");
  next.textContent = "Next";
  next.disabled = result.page >= result.totalPages;
  previous.addEventListener("click", () => goToPage(result.page - 1));
  next.addEventListener("click", () => goToPage(result.page + 1));
  elements.pagination.append(previous, label, next);
}

function goToPage(page) {
  const filters = currentFilters();
  filters.page = page;
  writeFilters(filters);
  void loadJobs();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

async function loadSettings() {
  try {
    const settings = await api("/api/settings");
    state.settings = settings;
    renderThreadOptions(settings.threads);
    renderSyncStatus(settings);
    if (window.location.pathname === "/settings" && document.activeElement !== elements.threadUrl) {
      elements.threadUrl.value = settings.active?.url || "";
    }
    return settings;
  } catch (error) {
    showToast(error.message || "Could not load settings.");
    return null;
  }
}

function renderThreadOptions(threads) {
  const current = currentFilters().thread;
  elements.thread.replaceChildren(new Option("All imported threads", "all"));
  threads.forEach((thread) => {
    const label = `${thread.title}${thread.is_active ? " (active)" : ""}`;
    elements.thread.append(new Option(label, String(thread.hn_id)));
  });
  elements.thread.value = current;
  if (!elements.thread.value) elements.thread.value = "all";
}

function formatDate(value) {
  return value ? new Date(value).toLocaleString() : "Never";
}

function renderSyncStatus(settings) {
  const active = settings.active;
  const latest = settings.latestSync;
  elements.syncPill.classList.toggle("syncing", active?.last_sync_status === "syncing");
  elements.syncPill.textContent = !active
    ? "No active thread"
    : active.last_sync_status === "syncing"
      ? "Syncing now"
      : `Last sync: ${active.last_sync_status}`;
  elements.syncNow.disabled = !active || active.last_sync_status === "syncing";
  const entries = [
    ["Active thread", active?.title || "Not configured"],
    ["Activity", active?.last_sync_status === "syncing" ? "Syncing" : "Idle"],
    ["Last result", active?.last_sync_status || "Never"],
    ["Last successful", formatDate(active?.last_successful_sync_at)],
    ["Discovered", latest?.candidate_count ?? "—"],
    ["Imported", latest?.imported_count ?? "—"],
    ["Failed", latest?.failed_count ?? "—"],
  ];
  elements.settingsStatus.replaceChildren();
  entries.forEach(([term, value]) => {
    const dt = document.createElement("dt");
    const dd = document.createElement("dd");
    dt.textContent = String(term);
    dd.textContent = String(value);
    elements.settingsStatus.append(dt, dd);
  });
}

async function loadJobs() {
  elements.jobsError.classList.add("hidden");
  const settings = state.settings || await loadSettings();
  const filters = currentFilters();
  syncFilterControls(filters);
  const params = new URLSearchParams({
    status: filters.status,
    thread: filters.thread,
    sort: filters.sort,
    page: String(filters.page),
  });
  const fromUtc = localDateToUtc(filters.from);
  const toUtc = localDateToUtc(filters.to, true);
  if (fromUtc) params.set("fromUtc", fromUtc);
  if (toUtc) params.set("toUtc", toUtc);
  try {
    const result = await api(`/api/jobs?${params}`);
    state.jobs = result;
    elements.jobsSummary.textContent = `${result.total.toLocaleString()} matching ${result.total === 1 ? "job" : "jobs"} · newest HN posts are fetched every five minutes`;
    elements.jobsList.replaceChildren();
    if (!settings?.active) {
      elements.jobsList.append(emptyState("Set the active thread", "Add this month’s Hacker News “Who is hiring?” URL in Settings.", true));
    } else if (!result.jobs.length) {
      elements.jobsList.append(emptyState("No matching jobs", "Try changing the filters, or wait for the current sync to finish."));
    } else {
      result.jobs.forEach((job) => elements.jobsList.append(makeJobCard(job)));
    }
    renderPagination(result);
    document.querySelectorAll("[data-relative-time]").forEach((element) => {
      element.textContent = relativeTime(element.dataset.relativeTime);
    });
  } catch (error) {
    elements.jobsError.textContent = error.message || "Could not load jobs.";
    elements.jobsError.classList.remove("hidden");
  }
}

function emptyState(title, message, settingsLink = false) {
  const wrapper = document.createElement("div");
  wrapper.className = "empty-state";
  const heading = document.createElement("h2");
  heading.textContent = title;
  const copy = document.createElement("p");
  copy.textContent = message;
  wrapper.append(heading, copy);
  if (settingsLink) {
    const link = document.createElement("a");
    link.href = "/settings";
    link.dataset.route = "";
    link.className = "button primary";
    link.textContent = "Open Settings";
    wrapper.append(link);
  }
  return wrapper;
}

elements.filters.addEventListener("change", () => {
  const filters = {
    status: elements.status.value,
    from: elements.from.value,
    to: elements.to.value,
    thread: elements.thread.value,
    sort: elements.sort.value,
    page: 1,
  };
  writeFilters(filters);
  void loadJobs();
});

document.querySelector("#clear-filters").addEventListener("click", () => {
  writeFilters({ status: "unseen", from: "", to: "", thread: "all", sort: "newest", page: 1 });
  void loadJobs();
});

elements.threadForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  elements.threadError.classList.add("hidden");
  elements.saveThread.disabled = true;
  elements.saveThread.textContent = "Validating…";
  try {
    await api("/api/settings/active-thread", {
      method: "PUT",
      body: JSON.stringify({ url: elements.threadUrl.value }),
    });
    showToast("Thread saved. Initial sync started.");
    await loadSettings();
  } catch (error) {
    elements.threadError.textContent = error.message || "Could not save this thread.";
    elements.threadError.classList.remove("hidden");
  } finally {
    elements.saveThread.disabled = false;
    elements.saveThread.textContent = "Save and sync";
  }
});

elements.syncNow.addEventListener("click", async () => {
  elements.syncNow.disabled = true;
  try {
    await api("/api/sync", { method: "POST", body: "{}" });
    showToast("Sync started.");
    await loadSettings();
  } catch (error) {
    showToast(error.message || "Could not start sync.");
  }
});

elements.newJobsNotice.addEventListener("click", () => {
  elements.newJobsNotice.classList.add("hidden");
  goToPage(1);
});

const events = new EventSource("/api/events");
events.addEventListener("jobs-imported", () => {
  if (window.location.pathname !== "/jobs") return;
  if (currentFilters().page === 1) void loadJobs();
  else elements.newJobsNotice.classList.remove("hidden");
});
events.addEventListener("sync-status", () => void loadSettings());

setInterval(() => {
  document.querySelectorAll("[data-relative-time]").forEach((element) => {
    element.textContent = relativeTime(element.dataset.relativeTime);
  });
}, 30_000);

void loadSettings().then(route);
