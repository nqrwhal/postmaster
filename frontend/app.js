// Postmaster static frontend.
// Calls the Worker API at API_BASE with Turnstile auth.

const API_BASE = "https://app.mayufei.com";
const TURNSTILE_SITE_KEY = "0x4AAAAAADXBuw66HBcFyGzG";
const BATCH_CAP = 10;
const REQUEST_DELAY_MS = 250;
const RECENT_KEY = "postmaster.recent.v1";
const RECENT_MAX = 25;

const CARRIERS = ["usps", "ups", "fedex"];
const CARRIER_LABEL = { usps: "USPS", ups: "UPS", fedex: "FedEx" };

// Status vocabulary. Keys are normalized lowercase upstream values;
// `label` is what we render. Unknown statuses fall back to title-cased raw.
const STATUS_MAP = {
  delivered:               { label: "Delivered",        group: "delivered" },
  out_for_delivery:        { label: "Out for delivery", group: "out_for_delivery" },
  in_transit:              { label: "In transit",       group: "in_transit" },
  pre_transit:             { label: "Pre transit",      group: "pre_transit" },
  unknown:                 { label: "Unknown",          group: "unknown" },
  available_for_pickup:    { label: "Awaiting pickup",  group: "available_for_pickup" },
  return_to_sender:        { label: "Return to sender", group: "return_to_sender" },
  failure:                 { label: "Failure",          group: "exception" },
  error:                   { label: "Error",            group: "exception" },
  exception:               { label: "Exception",        group: "exception" },
};

// Friendly labels for API error codes (raw code shown on hover).
const ERROR_LABEL = {
  carrier_error:           "Carrier error",
  invalid_tracking_number: "Invalid tracking number",
  unsupported_carrier:     "Unsupported carrier",
  not_found:               "Not found",
  rate_limited:            "Rate limited",
  refresh_rate_limited:    "Refresh limit hit",
  turnstile_required:      "Turnstile required",
  turnstile_invalid:       "Turnstile rejected",
  auth_required:           "Auth required",
  invalid_token:           "Invalid token",
  bad_response:            "Bad response",
};

const $ = (id) => document.getElementById(id);

const els = {
  input: $("input"),
  parse: $("parse"),
  clear: $("clear"),
  parseHint: $("parseHint"),
  refresh: $("refresh"),
  batchPanel: $("batchPanel"),
  batchBody: $("batchBody"),
  batchCount: $("batchCount"),
  batchSub: $("batchSub"),
  search: $("search"),
  searchStatus: $("searchStatus"),
  resultsPanel: $("resultsPanel"),
  resultsBody: $("resultsBody"),
  resultsSub: $("resultsSub"),
  filterRow: $("filterRow"),
  exportCsv: $("exportCsv"),
  recentPanel: $("recentPanel"),
  recentList: $("recentList"),
  recentClear: $("recentClear"),
  turnstileMount: $("turnstileMount"),
  apiBadge: $("apiBadge"),
  apiPopover: $("apiPopover"),
  apiBadgeWrap: $("apiBadgeWrap"),
};

const state = {
  batch: [], // [{ trackingNumber, carrier, ambiguous }]
  results: [], // [{ trackingNumber, carrier, ok, data?, error? }]
  expanded: new Set(), // tracking numbers expanded in results
  filter: "all",
  searching: false,
  turnstileWidgetId: null,
};

// ---------- parsing & detection ----------

function splitInput(raw) {
  // Split only on line breaks, commas, semicolons, and tabs.
  // Plain spaces are kept as part of the token so pasted labels like
  // "9400 1111 0615 1829 4531 66" stay together; normalize() strips them.
  return raw.split(/[\n\r,;\t]+/).map((s) => s.trim()).filter(Boolean);
}

function normalize(num) {
  return num.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function detectCarrier(num) {
  if (/^1Z[0-9A-Z]{16}$/.test(num)) return { carrier: "ups", ambiguous: false };
  if (/^[0-9]+$/.test(num)) {
    const len = num.length;
    if (len >= 20 && len <= 34) return { carrier: "usps", ambiguous: false };
    if (len >= 12 && len <= 15) return { carrier: "fedex", ambiguous: false };
  }
  return { carrier: "usps", ambiguous: true };
}

function parseAndStage(raw) {
  const tokens = splitInput(raw).map(normalize).filter(Boolean);
  const seen = new Set();
  const deduped = [];
  for (const t of tokens) {
    if (seen.has(t)) continue;
    seen.add(t);
    deduped.push(t);
  }
  const capped = deduped.slice(0, BATCH_CAP);
  const skipped = deduped.length - capped.length;

  state.batch = capped.map((t) => {
    const { carrier, ambiguous } = detectCarrier(t);
    return { trackingNumber: t, carrier, ambiguous };
  });

  return { count: capped.length, skipped };
}

// ---------- status / carrier formatting ----------

function statusInfo(raw) {
  const key = String(raw ?? "unknown").toLowerCase().replace(/[\s-]+/g, "_");
  const def = STATUS_MAP[key];
  if (def) return { label: def.label, group: def.group, raw: String(raw ?? "") };
  return { label: titleCase(String(raw ?? "Unknown")), group: "unknown", raw: String(raw ?? "") };
}

function titleCase(s) {
  return s
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase()
    .replace(/(^|\s)(\S)/g, (_m, sp, c) => sp + c.toUpperCase());
}

function errorLabel(code) {
  return ERROR_LABEL[code] ?? titleCase(code ?? "Error");
}

// ---------- render: batch ----------

function renderBatch() {
  const ambiguous = state.batch.filter((r) => r.ambiguous).length;
  if (state.batch.length === 0) {
    els.batchPanel.hidden = true;
    return;
  }
  els.batchPanel.hidden = false;
  els.batchCount.textContent = String(state.batch.length);
  els.batchSub.textContent = ambiguous
    ? `${ambiguous} row${ambiguous === 1 ? "" : "s"} need carrier confirmation.`
    : "Ready. Press Track batch to run.";

  els.batchBody.innerHTML = "";
  for (const row of state.batch) {
    const tr = document.createElement("tr");
    tr.className = "fade-in" + (row.ambiguous ? " row-ambiguous" : "");

    const tdNum = document.createElement("td");
    tdNum.innerHTML = `<span class="tracking-num" title="${escape(row.trackingNumber)}">${escape(row.trackingNumber)}</span>`;

    const tdCarrier = document.createElement("td");
    tdCarrier.appendChild(buildCarrierSelect(row));
    if (row.ambiguous) {
      const flag = document.createElement("span");
      flag.className = "ambig-flag";
      flag.textContent = "guess";
      flag.title = "Auto-detection was uncertain. Confirm the carrier.";
      tdCarrier.appendChild(flag);
    }

    const tdActions = document.createElement("td");
    tdActions.style.textAlign = "right";
    const removeBtn = document.createElement("button");
    removeBtn.className = "remove-row";
    removeBtn.type = "button";
    removeBtn.title = "Remove";
    removeBtn.setAttribute("aria-label", `Remove ${row.trackingNumber}`);
    removeBtn.textContent = "×";
    removeBtn.addEventListener("click", () => {
      state.batch = state.batch.filter((r) => r !== row);
      renderBatch();
    });
    tdActions.appendChild(removeBtn);

    tr.appendChild(tdNum);
    tr.appendChild(tdCarrier);
    tr.appendChild(tdActions);
    els.batchBody.appendChild(tr);
  }

  els.search.disabled = state.batch.length === 0;
}

function buildCarrierSelect(row) {
  const wrap = document.createElement("div");
  wrap.className = "carrier-select";
  wrap.setAttribute("role", "radiogroup");
  for (const c of CARRIERS) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.dataset.c = c;
    btn.textContent = CARRIER_LABEL[c];
    btn.title = c;
    if (c === row.carrier) btn.classList.add("is-active");
    btn.setAttribute("role", "radio");
    btn.setAttribute("aria-checked", c === row.carrier ? "true" : "false");
    btn.addEventListener("click", () => {
      row.carrier = c;
      row.ambiguous = false;
      renderBatch();
    });
    wrap.appendChild(btn);
  }
  return wrap;
}

// ---------- render: results ----------

function renderResults() {
  if (state.results.length === 0) {
    els.resultsPanel.hidden = true;
    return;
  }
  els.resultsPanel.hidden = false;

  const okCount = state.results.filter((r) => r.ok).length;
  els.resultsSub.textContent = state.searching
    ? `${okCount}/${state.results.length} done…`
    : `${okCount} of ${state.results.length} succeeded.`;

  renderFilters();

  const visible = state.results.filter(filterMatches);
  els.resultsBody.innerHTML = "";
  for (const r of visible) {
    appendResultRow(r);
  }
}

function filterMatches(r) {
  if (state.filter === "all") return true;
  if (state.filter === "errors") return !r.ok;
  if (!r.ok) return false;
  const info = statusInfo(r.data?.status);
  return info.group === state.filter;
}

function renderFilters() {
  const groups = {};
  for (const r of state.results) {
    const key = r.ok ? statusInfo(r.data?.status).group : "errors";
    groups[key] = (groups[key] ?? 0) + 1;
  }
  const order = [
    ["all", "All", state.results.length],
    ["delivered", "Delivered", groups.delivered],
    ["in_transit", "Transit", groups.in_transit],
    ["out_for_delivery", "Out", groups.out_for_delivery],
    ["pre_transit", "Pre", groups.pre_transit],
    ["exception", "Exception", groups.exception],
    ["errors", "Errors", groups.errors],
  ];
  els.filterRow.innerHTML = "";
  for (const [key, label, count] of order) {
    if (count === undefined && key !== "all") continue;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "filter-chip" + (state.filter === key ? " is-active" : "");
    btn.innerHTML = `${escape(label)}<span class="filter-count">${count ?? 0}</span>`;
    btn.addEventListener("click", () => {
      state.filter = key;
      renderResults();
    });
    els.filterRow.appendChild(btn);
  }
}

function appendResultRow(r) {
  const tr = document.createElement("tr");
  tr.className = "fade-in" + (r.ok ? "" : " is-error") + (r.pending ? " is-pending" : "");
  if (state.expanded.has(r.trackingNumber)) tr.classList.add("row-expanded");

  const tdNum = document.createElement("td");
  tdNum.innerHTML = `<span class="tracking-num" title="${escape(r.trackingNumber)}">${escape(r.trackingNumber)}</span>`;

  const tdCarrier = document.createElement("td");
  tdCarrier.innerHTML = renderCarrierChip(r.carrier);

  const tdStatus = document.createElement("td");
  if (r.ok) {
    const info = statusInfo(r.data?.status);
    tdStatus.innerHTML =
      `<span class="status-pill status--${escape(info.group)}" title="${escape(info.raw || "unknown")}">` +
      `${escape(info.label)}</span>`;
  } else {
    tdStatus.innerHTML =
      `<span class="status-pill status--exception" title="${escape(r.error.code)}">` +
      `${escape(errorLabel(r.error.code))}</span>`;
  }

  const tdEta = document.createElement("td");
  tdEta.innerHTML = r.ok && r.data?.estimatedDelivery
    ? `<span class="tracking-num" title="${escape(r.data.estimatedDelivery)}">${escape(formatDate(r.data.estimatedDelivery))}</span>`
    : `<span class="muted small">—</span>`;

  const tdLatest = document.createElement("td");
  if (r.ok) {
    const latest = r.data?.events?.[0];
    tdLatest.title = latest?.description ?? "";
    tdLatest.textContent = latest?.description ?? "—";
  } else {
    tdLatest.title = r.error.message ?? "";
    tdLatest.textContent = r.error.message ?? "";
  }

  const tdExpand = document.createElement("td");
  tdExpand.className = "expand-cell";
  tdExpand.innerHTML = `<span class="chev">›</span>`;

  tr.appendChild(tdNum);
  tr.appendChild(tdCarrier);
  tr.appendChild(tdStatus);
  tr.appendChild(tdEta);
  tr.appendChild(tdLatest);
  tr.appendChild(tdExpand);

  tr.addEventListener("click", () => {
    if (state.expanded.has(r.trackingNumber)) state.expanded.delete(r.trackingNumber);
    else state.expanded.add(r.trackingNumber);
    renderResults();
  });

  els.resultsBody.appendChild(tr);

  if (state.expanded.has(r.trackingNumber)) {
    const ex = document.createElement("tr");
    ex.className = "expand-row";
    const td = document.createElement("td");
    td.colSpan = 6;
    td.appendChild(buildExpand(r));
    ex.appendChild(td);
    els.resultsBody.appendChild(ex);
  }
}

function renderCarrierChip(carrier) {
  return (
    `<span class="carrier-chip carrier-${escape(carrier)}" title="${escape(carrier)}">` +
    `<span class="carrier-stripe" aria-hidden="true"></span>${escape(CARRIER_LABEL[carrier] ?? carrier)}</span>`
  );
}

function buildExpand(r) {
  const wrap = document.createElement("div");
  wrap.className = "expand-inner";

  const left = document.createElement("div");
  if (r.ok) {
    const events = r.data?.events ?? [];
    if (events.length === 0) {
      left.innerHTML = `<p class="empty-events">No scan events yet.</p>`;
    } else {
      const ul = document.createElement("ul");
      ul.className = "timeline";
      events.forEach((e, i) => {
        const li = document.createElement("li");
        const isLatest = i === 0;
        const isDelivered = /deliver/i.test(e.status ?? "") || /deliver/i.test(e.description ?? "");
        li.className = "timeline-item" +
          (isDelivered ? " is-delivered" : (isLatest ? " is-latest" : ""));
        const rawStatus = String(e.status ?? "");
        li.innerHTML =
          `<div class="event-time" title="${escape(e.timestamp ?? "")}">${escape(formatTimestamp(e.timestamp))}</div>` +
          `<div class="event-desc" title="${escape(rawStatus)}">${escape(e.description ?? statusInfo(rawStatus).label)}</div>` +
          (e.location ? `<div class="event-loc">${escape(e.location)}</div>` : "");
        ul.appendChild(li);
      });
      left.appendChild(ul);
    }
  } else {
    const p = document.createElement("p");
    p.className = "hint error";
    p.innerHTML =
      `<strong>${escape(errorLabel(r.error.code))}</strong> ` +
      `<span class="muted small" title="${escape(r.error.code)}">${escape(r.error.code)}</span><br/>` +
      `${escape(r.error.message ?? "")}` +
      (r.error.retryAfter ? `<br/><span class="muted small">Retry after ${escape(r.error.retryAfter)}s</span>` : "");
    left.appendChild(p);
  }

  const right = document.createElement("div");
  right.className = "expand-meta";
  if (r.ok) {
    const info = statusInfo(r.data?.status);
    const eventCount = r.data?.events?.length ?? 0;
    const rows = [
      ["Status", `<span title="${escape(info.raw)}">${escape(info.label)}</span>`],
      ["Carrier", CARRIER_LABEL[r.carrier] ?? r.carrier],
      ["ETA", r.data?.estimatedDelivery ? formatDate(r.data.estimatedDelivery) : "—"],
      ["Events", String(eventCount)],
    ];
    right.innerHTML = rows
      .map(([k, v]) => `<div><span class="meta-k">${escape(k)}</span><span class="meta-v">${v}</span></div>`)
      .join("");
  }

  wrap.appendChild(left);
  wrap.appendChild(right);
  return wrap;
}

// ---------- formatting ----------

function formatDate(s) {
  if (!s) return "";
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return s;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function formatTimestamp(s) {
  if (!s) return "—";
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return s;
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

// ---------- recent ----------

function loadRecent() {
  try {
    const raw = localStorage.getItem(RECENT_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function saveRecent(list) {
  try { localStorage.setItem(RECENT_KEY, JSON.stringify(list.slice(0, RECENT_MAX))); } catch {}
}

function pushRecent(entry) {
  const list = loadRecent();
  const key = `${entry.carrier}:${entry.trackingNumber}`;
  const filtered = list.filter((e) => `${e.carrier}:${e.trackingNumber}` !== key);
  filtered.unshift({ ...entry, lookedUpAt: new Date().toISOString() });
  saveRecent(filtered);
  renderRecent();
}

function renderRecent() {
  const list = loadRecent();
  if (!list.length) { els.recentPanel.hidden = true; return; }
  els.recentPanel.hidden = false;
  els.recentList.innerHTML = "";
  for (const e of list) {
    const li = document.createElement("li");
    li.innerHTML =
      `<span><span class="recent-carrier c-${escape(e.carrier)}" aria-hidden="true"></span>` +
      `<a href="#" data-num="${escape(e.trackingNumber)}" data-carrier="${escape(e.carrier)}" title="${escape(e.trackingNumber)}">${escape(e.trackingNumber)}</a></span>` +
      `<span class="recent-time" title="${escape(e.lookedUpAt)}">${escape(formatRelative(e.lookedUpAt))}</span>`;
    els.recentList.appendChild(li);
  }
  els.recentList.querySelectorAll("a").forEach((a) => {
    a.addEventListener("click", (ev) => {
      ev.preventDefault();
      const num = a.dataset.num;
      const carrier = a.dataset.carrier;
      els.input.value = num;
      parseAndStage(num);
      const row = state.batch[0];
      if (row) row.carrier = carrier;
      renderBatch();
      els.input.focus();
    });
  });
}

function formatRelative(iso) {
  const t = new Date(iso).getTime();
  const d = Date.now() - t;
  if (d < 60_000) return "just now";
  if (d < 3_600_000) return `${Math.floor(d / 60_000)}m`;
  if (d < 86_400_000) return `${Math.floor(d / 3_600_000)}h`;
  return `${Math.floor(d / 86_400_000)}d`;
}

// ---------- turnstile ----------

function ensureTurnstileReady() {
  return new Promise((resolve, reject) => {
    let tries = 0;
    const check = () => {
      if (window.turnstile) return resolve();
      if (++tries > 100) return reject(new Error("Turnstile failed to load"));
      setTimeout(check, 100);
    };
    check();
  });
}

let turnstilePending = null;

async function ensureTurnstileWidget() {
  await ensureTurnstileReady();
  if (state.turnstileWidgetId !== null) return;
  state.turnstileWidgetId = window.turnstile.render(els.turnstileMount, {
    sitekey: TURNSTILE_SITE_KEY,
    execution: "execute",
    appearance: "interaction-only",
    callback: (token) => {
      if (turnstilePending) { turnstilePending.resolve(token); turnstilePending = null; }
    },
    "error-callback": (code) => {
      if (turnstilePending) { turnstilePending.reject(new Error(`Turnstile error: ${code ?? "unknown"}`)); turnstilePending = null; }
    },
    "timeout-callback": () => {
      if (turnstilePending) { turnstilePending.reject(new Error("Turnstile timeout")); turnstilePending = null; }
    },
  });
}

async function getTurnstileToken() {
  await ensureTurnstileWidget();
  return new Promise((resolve, reject) => {
    turnstilePending = { resolve, reject };
    window.turnstile.reset(state.turnstileWidgetId);
    window.turnstile.execute(state.turnstileWidgetId);
  });
}

// ---------- API ----------

async function trackOne(row, opts) {
  const token = await getTurnstileToken();
  const url = new URL(`${API_BASE}/tracking/${row.carrier}/${encodeURIComponent(row.trackingNumber)}`);
  if (opts.refresh) url.searchParams.set("refresh", "true");
  const res = await fetch(url, { headers: { "x-turnstile-token": token } });
  const body = await res.json().catch(() => ({ error: "bad_response" }));
  if (!res.ok) {
    const err = new Error(body.message || body.error || `HTTP ${res.status}`);
    err.code = body.error || `http_${res.status}`;
    err.retryAfter = res.headers.get("retry-after") ?? undefined;
    throw err;
  }
  return body;
}

// ---------- search flow ----------

async function runSearch() {
  if (!state.batch.length) return;
  const ambiguous = state.batch.find((r) => r.ambiguous);
  if (ambiguous) {
    els.parseHint.textContent = "Confirm carriers on the flagged rows first.";
    els.parseHint.classList.add("error");
    return;
  }
  els.parseHint.classList.remove("error");
  els.parseHint.textContent = "";

  state.searching = true;
  state.results = state.batch.map((r) => ({
    trackingNumber: r.trackingNumber,
    carrier: r.carrier,
    ok: false,
    pending: true,
    error: { code: "pending", message: "" },
  }));
  state.expanded.clear();
  state.filter = "all";
  els.search.classList.add("is-loading");
  els.search.disabled = true;
  renderResults();

  const refresh = els.refresh.checked;
  let done = 0;
  for (let i = 0; i < state.batch.length; i++) {
    const row = state.batch[i];
    els.searchStatus.textContent = `Tracking ${i + 1}/${state.batch.length}…`;
    try {
      const data = await trackOne(row, { refresh });
      state.results[i] = { trackingNumber: row.trackingNumber, carrier: row.carrier, ok: true, data };
      pushRecent({ trackingNumber: row.trackingNumber, carrier: row.carrier });
    } catch (err) {
      state.results[i] = {
        trackingNumber: row.trackingNumber,
        carrier: row.carrier,
        ok: false,
        error: { code: err.code ?? "error", message: err.message, retryAfter: err.retryAfter },
      };
    }
    done++;
    renderResults();
    if (i < state.batch.length - 1) await sleep(REQUEST_DELAY_MS);
  }

  state.searching = false;
  els.search.classList.remove("is-loading");
  els.search.disabled = false;
  els.searchStatus.textContent = `Done. ${state.results.filter((r) => r.ok).length}/${state.results.length} succeeded.`;
  setTimeout(() => { els.searchStatus.textContent = ""; }, 4000);
}

// ---------- csv ----------

function toCsv() {
  const header = ["tracking_number", "carrier", "status_label", "status_raw", "estimated_delivery", "latest_event", "error_code", "error_message"];
  const rows = [header];
  for (const r of state.results) {
    if (r.ok) {
      const info = statusInfo(r.data?.status);
      rows.push([
        r.trackingNumber, r.carrier, info.label, info.raw,
        r.data?.estimatedDelivery ?? "",
        r.data?.events?.[0]?.description ?? "",
        "", "",
      ]);
    } else {
      rows.push([r.trackingNumber, r.carrier, "", "", "", "", r.error.code ?? "", r.error.message ?? ""]);
    }
  }
  return rows.map((r) => r.map(csvCell).join(",")).join("\n");
}

function csvCell(v) {
  const s = String(v ?? "");
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function downloadCsv() {
  if (!state.results.length) return;
  const blob = new Blob([toCsv()], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `postmaster-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// ---------- helpers ----------

function escape(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// ---------- wire ----------

els.parse.addEventListener("click", () => {
  const { count, skipped } = parseAndStage(els.input.value);
  if (!count) {
    els.parseHint.textContent = "Paste at least one tracking number.";
    els.parseHint.classList.add("error");
    els.batchPanel.hidden = true;
    return;
  }
  els.parseHint.classList.remove("error");
  els.parseHint.textContent = skipped > 0 ? `Capped at ${BATCH_CAP}; dropped ${skipped} extra.` : "";
  renderBatch();
});

els.clear.addEventListener("click", () => {
  els.input.value = "";
  state.batch = [];
  state.results = [];
  state.expanded.clear();
  els.parseHint.textContent = "";
  els.parseHint.classList.remove("error");
  els.searchStatus.textContent = "";
  renderBatch();
  renderResults();
  els.input.focus();
});

els.search.addEventListener("click", runSearch);
els.exportCsv.addEventListener("click", downloadCsv);
els.recentClear.addEventListener("click", () => {
  localStorage.removeItem(RECENT_KEY);
  renderRecent();
});

// Cmd/Ctrl+Enter from the textarea: review → if already batched, run.
els.input.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
    e.preventDefault();
    if (els.batchPanel.hidden) els.parse.click();
    else if (!els.search.disabled) els.search.click();
  }
});

// API badge popover
function setApiPopover(open) {
  els.apiPopover.hidden = !open;
  els.apiBadge.setAttribute("aria-expanded", open ? "true" : "false");
}
els.apiBadge.addEventListener("click", (e) => {
  e.stopPropagation();
  setApiPopover(els.apiPopover.hidden);
});
document.addEventListener("click", (e) => {
  if (!els.apiBadgeWrap.contains(e.target)) setApiPopover(false);
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") setApiPopover(false);
});

renderRecent();
els.input.focus();
