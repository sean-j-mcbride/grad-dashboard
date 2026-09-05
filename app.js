"use strict";

/* Grad Tech Dashboard.
   Static page over two JSON files: data/opportunities.json (the curated feed) and
   data/practice-today.json (the coach's plan). Everything personal — saved roles,
   notes, ticked problems — lives in localStorage and never leaves the browser. */

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

const VIEWS = ["curated", "targets", "closing", "opening", "new", "shortlist", "applied", "all"];
const STATUSES = ["shortlist", "applied", "dismissed"];
const STATUS_LABEL = { shortlist: "Saved", applied: "Applied", dismissed: "Dismissed" };
const STATUS_ACTION = { shortlist: "Save", applied: "Applied", dismissed: "Dismiss" };
// How many extra problems the "More practice" button reveals per press.
const MORE_STEP = 2;

const state = {
  feed: null,
  practice: null,
  types: new Set(),
  seasons: new Set(),
  view: "curated",
  sortKey: "rank",
  sortDir: -1,          // -1 desc, 1 asc
  q: "",
  scotOnly: false,
  within: null,
  marks: {},            // opportunity key -> {status, note}
  solved: {},           // problem slug -> true
  moreShown: 0,         // extra practice problems revealed today
  cursor: -1,
  rows: [],
};

// ---- persistence -----------------------------------------------------------
const store = {
  get(k, fallback) {
    try {
      const v = localStorage.getItem(k);
      return v == null ? fallback : JSON.parse(v);
    } catch (_) { return fallback; }
  },
  set(k, v) {
    try { localStorage.setItem(k, JSON.stringify(v)); } catch (_) {}
  },
};

// ---- theme -----------------------------------------------------------------
(function initTheme() {
  const saved = store.get("gtd-theme", null);
  if (saved === "light" || saved === "dark") {
    document.documentElement.setAttribute("data-theme", saved);
  }
  $("#theme").addEventListener("click", () => {
    const cur = document.documentElement.getAttribute("data-theme");
    const isDark = cur ? cur === "dark"
      : window.matchMedia("(prefers-color-scheme: dark)").matches;
    const next = isDark ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", next);
    store.set("gtd-theme", next);
  });
})();

// ---- load ------------------------------------------------------------------
Promise.allSettled([
  fetch("data/opportunities.json").then((r) => r.json()),
  fetch("data/practice-today.json").then((r) => r.json()),
]).then(([opp, prac]) => {
  if (opp.status === "fulfilled") state.feed = opp.value;
  if (prac.status === "fulfilled") state.practice = prac.value;
  if (!state.feed) {
    $("#list").innerHTML =
      '<li class="empty"><p>Could not load <code>data/opportunities.json</code>.</p></li>';
    if (state.practice) { bootstrapPractice(); }
    return;
  }
  bootstrap();
});

function bootstrap() {
  state.marks = store.get("gtd-marks", {});
  readHash();

  const f = state.feed;
  $("#credit").textContent = (f.credit && f.credit.text) || "Data via Trackr";
  $("#updated").textContent = f.generated_at ? "updated " + shortStamp(f.generated_at) : "";

  buildChipFilters();
  bootstrapPractice();
  wireControls();
  renderCoverageNotice();
  render();
}

// ---- URL hash (shareable / reload-stable filter state) ---------------------
function readHash() {
  const p = new URLSearchParams(location.hash.slice(1));
  if (VIEWS.includes(p.get("view"))) state.view = p.get("view");
  if (p.get("q")) state.q = p.get("q");
  if (p.get("sort")) state.sortKey = p.get("sort");
  if (p.get("dir")) state.sortDir = p.get("dir") === "asc" ? 1 : -1;
  if (p.get("within")) state.within = Number(p.get("within"));
  if (p.get("scot")) state.scotOnly = p.get("scot") === "1";
  (p.get("types") || "").split(",").filter(Boolean).forEach((t) => state.types.add(t));
  (p.get("seasons") || "").split(",").filter(Boolean).forEach((s) => state.seasons.add(s));
}

function writeHash() {
  const p = new URLSearchParams();
  if (state.view !== "curated") p.set("view", state.view);
  if (state.q) p.set("q", state.q);
  if (state.sortKey !== "rank") p.set("sort", state.sortKey);
  if (state.sortDir === 1) p.set("dir", "asc");
  if (state.within != null) p.set("within", String(state.within));
  if (state.scotOnly) p.set("scot", "1");
  if (state.types.size) p.set("types", Array.from(state.types).join(","));
  if (state.seasons.size) p.set("seasons", Array.from(state.seasons).join(","));
  const s = p.toString();
  history.replaceState(null, "", s ? "#" + s : location.pathname);
}

// ---- filter chips ----------------------------------------------------------
function buildChipFilters() {
  const open = openRows();
  fillChips($("#typeFilters"), tally(open, (r) => r.type), state.types, prettyType);
  fillChips($("#seasonFilters"), tally(open, (r) => r.season || "undated"), state.seasons, (s) => s);
}

function tally(rows, keyFn) {
  const m = new Map();
  rows.forEach((r) => {
    const k = keyFn(r);
    m.set(k, (m.get(k) || 0) + 1);
  });
  return Array.from(m.entries()).sort((a, b) => b[1] - a[1]);
}

function fillChips(box, counts, set, label) {
  box.textContent = "";
  counts.forEach(([value, n]) => {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = `${label(value)} ${n}`;
    b.dataset.value = value;
    b.setAttribute("aria-pressed", String(set.has(value)));
    b.classList.toggle("on", set.has(value));
    b.addEventListener("click", () => {
      set.has(value) ? set.delete(value) : set.add(value);
      b.classList.toggle("on");
      b.setAttribute("aria-pressed", String(set.has(value)));
      state.cursor = -1;
      render();
    });
    box.appendChild(b);
  });
}

// ---- controls --------------------------------------------------------------
function wireControls() {
  const q = $("#q");
  q.value = state.q;
  q.addEventListener("input", () => { state.q = q.value; state.cursor = -1; render(); });

  const within = $("#within");
  within.value = state.within == null ? "" : String(state.within);
  within.addEventListener("input", () => {
    const v = within.value.trim();
    state.within = v === "" || Number.isNaN(Number(v)) ? null : Number(v);
    render();
  });

  const scot = $("#scotOnly");
  scot.checked = state.scotOnly;
  scot.addEventListener("change", () => { state.scotOnly = scot.checked; render(); });

  const sort = $("#sort");
  sort.value = state.sortKey;
  sort.addEventListener("change", () => { state.sortKey = sort.value; render(); });

  $("#sortDir").addEventListener("click", () => { state.sortDir *= -1; render(); });

  $("#filterToggle").addEventListener("click", toggleFilters);

  $("#tabs").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-view]");
    if (b) setView(b.dataset.view);
  });

  $("#statstrip").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-view]");
    if (b) setView(b.dataset.view);
  });

  $("#reset").addEventListener("click", resetFilters);

  const dlg = $("#helpDlg");
  const openHelp = () => (dlg.showModal ? dlg.showModal() : null);
  $("#help").addEventListener("click", openHelp);
  $("#help2").addEventListener("click", openHelp);

  document.addEventListener("keydown", onKey);
}

function setView(v) {
  state.view = v;
  state.cursor = -1;
  render();
}

function toggleFilters(force) {
  const panel = $("#filterPanel");
  const open = typeof force === "boolean" ? force : panel.hidden;
  panel.hidden = !open;
  $("#filterToggle").setAttribute("aria-expanded", String(open));
  $("#filterToggle").classList.toggle("on", open);
}

function resetFilters() {
  state.q = ""; state.within = null; state.scotOnly = false;
  state.types.clear(); state.seasons.clear();
  state.sortKey = "rank"; state.sortDir = -1;
  $("#q").value = ""; $("#within").value = ""; $("#scotOnly").checked = false;
  $("#sort").value = "rank";
  buildChipFilters();
  state.cursor = -1;
  render();
}

function onKey(e) {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const typing = /^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName);
  if (e.key === "/" && !typing) { e.preventDefault(); $("#q").focus(); return; }
  if (e.key === "Escape" && typing) { e.target.blur(); return; }
  if (typing) return;

  if (e.key === "?") { $("#helpDlg").showModal(); return; }
  if (e.key === "f") { e.preventDefault(); toggleFilters(); return; }
  if (e.key >= "1" && e.key <= "7") { setView(VIEWS[Number(e.key) - 1]); return; }

  const max = state.rows.length - 1;
  if (e.key === "j" || e.key === "ArrowDown") { moveCursor(Math.min(max, state.cursor + 1)); e.preventDefault(); }
  else if (e.key === "k" || e.key === "ArrowUp") { moveCursor(Math.max(0, state.cursor - 1)); e.preventDefault(); }
  else if (state.cursor >= 0) {
    const row = state.rows[state.cursor];
    if (!row) return;
    if (e.key === "Enter" && row.url) window.open(row.url, "_blank", "noopener");
    else if (e.key === "s") setStatus(row.key, "shortlist");
    else if (e.key === "a") setStatus(row.key, "applied");
    else if (e.key === "x") setStatus(row.key, "dismissed");
    else if (e.key === "o") toggleExpand(row.key);
  }
}

function moveCursor(i) {
  state.cursor = i;
  const cards = $$(".item");
  cards.forEach((c, n) => c.classList.toggle("cursor", n === i));
  if (cards[i]) cards[i].scrollIntoView({ block: "nearest" });
}

// ---- marks (saved / applied / dismissed) -----------------------------------
function markOf(key) {
  return state.marks[key] || { status: "none", note: "" };
}

function setStatus(key, status) {
  const cur = markOf(key);
  const next = cur.status === status ? "none" : status;   // pressing again clears it
  state.marks[key] = { ...cur, status: next };
  if (next === "none" && !state.marks[key].note) delete state.marks[key];
  store.set("gtd-marks", state.marks);
  render();
}

function setNote(key, note) {
  const cur = markOf(key);
  state.marks[key] = { ...cur, note };
  if (!note && cur.status === "none") delete state.marks[key];
  store.set("gtd-marks", state.marks);
}

const expanded = new Set();
function toggleExpand(key) {
  expanded.has(key) ? expanded.delete(key) : expanded.add(key);
  render();
}

// ---- practice --------------------------------------------------------------
function bootstrapPractice() {
  const p = state.practice;
  if (!p) return;
  state.solved = store.get("gtd-solved", {});
  // "How many extras have I asked for?" resets with each new plan.
  const key = "gtd-more-" + (p.date || "x");
  state.moreShown = Math.min(store.get(key, 0), (p.extra_problems || []).length);
  $("#practice").hidden = false;
  renderAssessment();
  renderPractice();
}

/* ---- booked assessment ----------------------------------------------------
   Everything else on this page is inferred — a deadline Trackr publishes on 4 rows
   in 384, or last cycle's opening date, which is explicitly not a forecast. A test
   Sean has been invited to sit is neither, so it gets the top of the column and a
   day-by-day plan rather than a chip. Driven by targets.yaml `assessment_on:`. */
function renderAssessment() {
  const a = state.practice && state.practice.assessment;
  const panel = $("#assessment");
  if (!a) { panel.hidden = true; return; }
  panel.hidden = false;

  $("#assessTitle").textContent = `${a.company} ${a.label}`;
  const due = $("#assessDue");
  due.textContent = a.due_label;
  due.className = "pip " + (a.in_days <= 1 ? "hot" : a.in_days <= 3 ? "warm" : "");

  const body = $("#assessment-body");
  body.textContent = "";

  const head = document.createElement("div");
  head.className = "assess-head";
  head.innerHTML =
    `<div class="when">${esc(a.date_label)} · <strong>${esc(a.platform)}</strong></div>` +
    (a.style ? `<div class="how">${esc(a.style)}</div>` : "");
  body.appendChild(head);

  // What this company actually asks about, from LeetCode's company tags. This is
  // evidence rather than the hand-written hint in assessments.yaml, so it says how
  // much of it there is: ~1,360 tagged problems for Bloomberg reads very
  // differently from 19 for BlackRock, and the panel must not flatten that.
  if ((a.topic_profile || []).length) body.appendChild(topicsEl(a));

  // Progress through the problems this company is actually known to ask, ticked
  // with the same checkboxes as the daily set.
  const sig = a.problems || [];
  if (sig.length) {
    const solved = sig.filter((q) => state.solved[q.slug] || q.done).length;
    const prog = document.createElement("div");
    prog.className = "progress";
    prog.innerHTML =
      `<div class="lbl"><span>Queued for this test</span>` +
      `<span>${solved}/${sig.length}</span></div>` +
      `<div class="bar"><i style="width:${(solved / sig.length) * 100}%"></i></div>`;
    body.appendChild(prog);
  }

  body.appendChild(countdownEl(a));

  if (a.prep_notes) {
    const d = document.createElement("div");
    d.className = "assess-note";
    d.textContent = a.prep_notes;
    body.appendChild(d);
  }
  if (a.note) {
    const d = document.createElement("div");
    d.className = "assess-note check";
    d.textContent = a.note;
    body.appendChild(d);
  }
}

function topicsEl(a) {
  const wrap = document.createElement("div");
  wrap.className = "topics";
  const head = document.createElement("div");
  head.className = "topics-head";
  head.textContent = "What they ask about";
  wrap.appendChild(head);

  const bars = document.createElement("div");
  bars.className = "topicbars";
  const top = (a.topic_profile || []).slice(0, 6);
  const max = Math.max(...top.map(([, n]) => n), 1);
  top.forEach(([topic, n]) => {
    const row = document.createElement("div");
    row.className = "topicrow";
    row.innerHTML =
      `<span class="tname">${esc(topic)}</span>` +
      `<span class="tbar"><i style="width:${(n / max) * 100}%"></i></span>` +
      `<span class="tn">${n}</span>`;
    bars.appendChild(row);
  });
  wrap.appendChild(bars);

  const src = document.createElement("p");
  src.className = "topics-src";
  src.textContent = a.evidence_thin
    ? `Only ${a.tagged_total} LeetCode problems are tagged ${a.company} — enough to `
      + "aim with, not a pattern. The rest of the plan matches this topic mix rather "
      + "than claiming it was asked."
    : `From ${a.tagged_total} LeetCode problems tagged ${a.company}.`;
  if (a.evidence_thin) src.classList.add("thin");
  wrap.appendChild(src);
  return wrap;
}

function countdownEl(a) {
  const ol = document.createElement("ol");
  ol.className = "countdown";
  (a.countdown || []).forEach((row) => {
    const li = document.createElement("li");
    li.className = "cd " + row.kind + (row.is_today ? " today" : "");

    const head = document.createElement("div");
    head.className = "cd-head";
    head.innerHTML =
      `<span class="cd-day">${esc(row.label)}</span>` +
      `<span class="cd-kind">${esc(row.kind === "test" ? "the test"
        : row.kind === "rehearsal" ? "mock" : "drill")}</span>`;
    li.appendChild(head);

    // Only today and the test day are worth reading in full; the rest are a
    // schedule, and a wall of identical instructions would bury them.
    const task = document.createElement("p");
    task.className = "cd-task";
    task.textContent = row.task;
    if (!row.is_today && row.kind !== "test") task.classList.add("dim");
    li.appendChild(task);

    if ((row.problems || []).length) {
      const ul = document.createElement("ul");
      ul.className = "cd-probs";
      row.problems.forEach((q) => {
        const item = document.createElement("li");
        const done = !!state.solved[q.slug];
        item.className = done ? "done" : "";
        item.innerHTML =
          `<a href="${esc(q.url || q.neetcode_url)}" rel="noopener">${esc(q.name)}</a>` +
          `<span class="cd-meta">${esc(q.difficulty)} · ~${q.est_minutes}m</span>`;
        ul.appendChild(item);
      });
      li.appendChild(ul);
    }
    ol.appendChild(li);
  });
  return ol;
}

function saveMoreShown() {
  store.set("gtd-more-" + (state.practice.date || "x"), state.moreShown);
}

function renderPractice() {
  const p = state.practice;
  const body = $("#practice-body");
  body.textContent = "";

  const streak = p.streak || 0;
  const chip = $("#streak");
  chip.textContent = streak ? `${streak}-day streak` : "no streak yet";
  chip.classList.toggle("hot", streak >= 3);

  if (p.focus) body.appendChild(focusEl(p.focus));
  body.appendChild(progressEl(p));

  const core = p.problems || [];
  const ul = document.createElement("ul");
  ul.className = "problems";
  if (p.warmup) ul.appendChild(problemLi(p.warmup, "warm-up"));
  core.forEach((pr) => ul.appendChild(problemLi(pr)));

  // The on-demand queue is pre-computed by the coach and revealed a couple at a
  // time — the page is static, so there is nothing to fetch on click.
  const extras = p.extra_problems || [];
  extras.slice(0, state.moreShown).forEach((pr) => ul.appendChild(problemLi(pr, "extra")));
  body.appendChild(ul);

  body.appendChild(moreEl(core, extras));

  if (p.timed_simulation) {
    const d = document.createElement("div");
    d.className = "sim";
    d.innerHTML = `<strong>Timed simulation — ${p.timed_simulation.budget_min} min:</strong> ` +
      p.timed_simulation.problems.map((q) =>
        `<a href="${esc(q.url || q.neetcode_url)}" rel="noopener">${esc(q.name)}</a>`).join(", ");
    body.appendChild(d);
  }

  if ((p.notes || []).length) {
    const det = document.createElement("details");
    det.className = "notes";
    const sum = document.createElement("summary");
    sum.textContent = `Coach notes (${p.notes.length})`;
    det.appendChild(sum);
    p.notes.forEach((n) => {
      const d = document.createElement("div");
      d.className = "note";
      d.textContent = n;
      det.appendChild(d);
    });
    body.appendChild(det);
  }

  const fine = document.createElement("p");
  fine.className = "fineprint";
  fine.innerHTML = 'Problems open on <a href="https://neetcode.io/practice" rel="noopener">neetcode.io</a>' +
    ' — free for all 150, including the seven that are LeetCode Premium.';
  body.appendChild(fine);
}

function focusEl(f) {
  const d = document.createElement("div");
  d.className = "focus";
  const due = f.has_live_listing === false
    ? "no live listing yet — prepping ahead"
    : f.closes_in_days != null
      ? `closes in ${f.closes_in_days} d`
      : (f.is_rolling ? "rolling — apply early" : "open now");
  d.innerHTML =
    `<div class="who">Aimed at ${esc(f.company)}</div>` +
    `<div class="role">${esc(f.role || "")}${f.role ? " · " : ""}${esc(due)}</div>` +
    `<div class="how"><strong>${esc(f.platform)}</strong> — ${esc(f.style || "")}</div>`;
  return d;
}

function progressEl(p) {
  const prog = p.curriculum_progress || {};
  const done = prog.done ?? 0;
  const total = prog.total ?? 150;
  const core = p.problems || [];
  const coreDone = core.filter((q) => state.solved[q.slug]).length;

  const d = document.createElement("div");
  d.className = "progress";
  d.innerHTML =
    `<div class="lbl"><span>Today: ${coreDone}/${core.length} done</span>` +
    `<span>NeetCode 150 · ${done}/${total}</span></div>` +
    `<div class="bar"><i style="width:${total ? (done / total) * 100 : 0}%"></i></div>`;
  return d;
}

function moreEl(core, extras) {
  const box = document.createElement("div");
  box.className = "moreblock";
  const left = extras.length - state.moreShown;
  if (left <= 0) {
    if (extras.length) {
      const p = document.createElement("p");
      p.className = "morehint";
      p.textContent = "That's the whole queue for today — " +
        "run `trackrjobs practice -n 12` for a longer set.";
      box.appendChild(p);
    }
    return box;
  }

  const coreDone = core.length > 0 && core.every((q) => state.solved[q.slug]);
  const b = document.createElement("button");
  b.className = coreDone ? "primary" : "ghost";
  b.textContent = `More practice (+${Math.min(MORE_STEP, left)})`;
  b.addEventListener("click", () => {
    state.moreShown = Math.min(extras.length, state.moreShown + MORE_STEP);
    saveMoreShown();
    renderPractice();
  });
  box.appendChild(b);

  const hint = document.createElement("p");
  hint.className = "morehint";
  hint.textContent = coreDone
    ? `${left} more queued for today.`
    : `${left} more queued — finish today's set first, or grab them anyway.`;
  box.appendChild(hint);
  return box;
}

function problemLi(pr, tag = "") {
  const li = document.createElement("li");
  const done = !!state.solved[pr.slug];
  li.className = "problem" + (done ? " done" : "");

  const cb = document.createElement("input");
  cb.type = "checkbox";
  cb.checked = done;
  cb.setAttribute("aria-label", "Mark " + pr.name + " solved");
  cb.title = "Mark solved (this browser only — `trackrjobs log` records it properly)";
  cb.addEventListener("change", () => {
    if (cb.checked) state.solved[pr.slug] = true; else delete state.solved[pr.slug];
    store.set("gtd-solved", state.solved);
    renderAssessment(); // the countdown strikes through the same problems
    renderPractice();   // ticking the last one unlocks "More practice"
  });
  li.appendChild(cb);

  const main = document.createElement("div");
  const url = pr.url || pr.neetcode_url;
  main.innerHTML =
    `<div class="pname">` +
    (tag ? `<span class="badge tag">${esc(tag)}</span> ` : "") +
    `<a href="${esc(url)}" rel="noopener">${esc(pr.name)}</a></div>` +
    `<div class="pmeta">${esc(pr.difficulty)} · ${esc(pr.topic)} · ~${pr.est_minutes}m` +
    (pr.why ? ` · ${esc(pr.why)}` : "") +
    (pr.leetcode_premium
      ? ` · <span class="premium">LC Premium</span>`
      : ` · <a href="${esc(pr.leetcode_url)}" rel="noopener">LeetCode</a>`) +
    `</div>`;

  const log = document.createElement("button");
  log.className = "plog";
  log.textContent = "copy log cmd";
  log.title = "Copy the `trackrjobs log` command for this problem";
  log.addEventListener("click", () => {
    navigator.clipboard?.writeText(`uv run trackrjobs log ${pr.slug} --time `);
    log.textContent = "copied";
    setTimeout(() => { log.textContent = "copy log cmd"; }, 1200);
  });
  main.querySelector(".pmeta").appendChild(log);
  li.appendChild(main);
  return li;
}

/* A company on targets.yaml that matched nothing is worth saying out loud: it is
   either genuinely unlisted, or its id has drifted from what the source calls it —
   which is how JPMorgan sat in the feed unstarred and below the relevance floor.
   Dismissal is remembered per set of names, so a new gap speaks up again. */
function renderCoverageNotice() {
  const cov = state.feed.target_coverage || {};
  const missing = cov.unmatched || [];
  const box = $("#coverage");
  if (!missing.length) { box.hidden = true; return; }
  const sig = missing.slice().sort().join("|");
  if (store.get("gtd-cov-dismissed", "") === sig) { box.hidden = true; return; }

  box.hidden = false;
  box.textContent = "";
  const txt = document.createElement("span");
  txt.innerHTML = `No open roles matched <strong>${esc(missing.join(", "))}</strong> ` +
    `— not listed by the source, or the <code>company_id</code> in targets.yaml has drifted.`;
  box.appendChild(txt);
  const x = document.createElement("button");
  x.className = "ghost tiny";
  x.textContent = "Dismiss";
  x.addEventListener("click", () => {
    store.set("gtd-cov-dismissed", sig);
    box.hidden = true;
  });
  box.appendChild(x);
}

// ---- list ------------------------------------------------------------------
function openRows() {
  return state.feed.opportunities.filter((r) => r.status === "open");
}

function render() {
  writeHash();
  const rows = filtered();
  state.rows = rows;
  renderStats();
  renderTabs();
  renderActiveFilters();
  $("#sortDir").textContent = state.sortDir === -1 ? "↓" : "↑";
  $("#count").textContent = `${rows.length} shown`;

  const list = $("#list");
  list.textContent = "";
  if (!rows.length) {
    list.appendChild(emptyEl());
    return;
  }
  const frag = document.createDocumentFragment();
  rows.forEach((r) => frag.appendChild(itemEl(r)));
  list.appendChild(frag);
  if (state.cursor >= 0) moveCursor(Math.min(state.cursor, rows.length - 1));
}

function counts() {
  const open = openRows();
  return {
    curated: open.filter((r) => r.curated).length,
    targets: open.filter((r) => r.is_target).length,
    new: open.filter((r) => r.is_new).length,
    closing: open.filter((r) => r.closes_in_days != null && r.closes_in_days >= 0
      && r.closes_in_days <= 14).length,
    opening: open.filter((r) => r.opening_window).length,
    shortlist: open.filter((r) => markOf(r.key).status === "shortlist").length,
    applied: open.filter((r) => markOf(r.key).status === "applied").length,
    all: open.length,
  };
}

function renderStats() {
  const c = counts();
  const tiles = [
    { view: "curated", n: c.curated, label: "worth a look" },
    { view: "targets", n: c.targets, label: "at target companies" },
    { view: "closing", n: c.closing, label: "closing ≤14 days", cls: c.closing ? "urgent" : "" },
    { view: "opening", n: c.opening, label: "due to open" },
    { view: "new", n: c.new, label: "new this week", cls: c.new ? "good" : "" },
    { view: "applied", n: c.applied, label: "applied" },
  ];
  const strip = $("#statstrip");
  strip.textContent = "";
  tiles.forEach((t) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "stat " + (t.cls || "") + (state.view === t.view ? " on" : "");
    b.dataset.view = t.view;
    b.setAttribute("aria-pressed", String(state.view === t.view));
    b.innerHTML = `<span class="num">${t.n}</span><span class="lbl">${esc(t.label)}</span>`;
    strip.appendChild(b);
  });
}

function renderTabs() {
  const c = counts();
  $$("#tabs button[data-view]").forEach((b) => {
    const v = b.dataset.view;
    b.querySelector(".n").textContent = c[v] ?? 0;
    b.classList.toggle("on", state.view === v);
    b.setAttribute("aria-pressed", String(state.view === v));
  });
}

/* Filters live in a collapsed panel, so anything active has to be visible out
   here — otherwise an empty list looks like missing data rather than a filter. */
function renderActiveFilters() {
  const box = $("#activeFilters");
  box.textContent = "";
  const pills = [];
  if (state.q) pills.push({ label: `“${state.q}”`, clear: () => { state.q = ""; $("#q").value = ""; } });
  state.types.forEach((t) => pills.push({ label: prettyType(t), clear: () => state.types.delete(t) }));
  state.seasons.forEach((s) => pills.push({ label: s, clear: () => state.seasons.delete(s) }));
  if (state.scotOnly) {
    pills.push({ label: "Scotland / remote", clear: () => { state.scotOnly = false; $("#scotOnly").checked = false; } });
  }
  if (state.within != null) {
    pills.push({ label: `closes ≤ ${state.within}d`, clear: () => { state.within = null; $("#within").value = ""; } });
  }

  $("#filterCount").hidden = pills.length === 0;
  $("#filterCount").textContent = String(pills.length);
  box.hidden = pills.length === 0;
  if (!pills.length) return;

  pills.forEach((p) => {
    const s = document.createElement("span");
    s.className = "fpill";
    s.append(p.label);
    const x = document.createElement("button");
    x.type = "button";
    x.textContent = "×";
    x.setAttribute("aria-label", "Remove filter " + p.label);
    x.addEventListener("click", () => {
      p.clear();
      buildChipFilters();
      state.cursor = -1;
      render();
    });
    s.appendChild(x);
    box.appendChild(s);
  });
  const clear = document.createElement("button");
  clear.className = "ghost tiny";
  clear.textContent = "Clear all";
  clear.addEventListener("click", resetFilters);
  box.appendChild(clear);
}

function emptyEl() {
  const li = document.createElement("li");
  li.className = "empty";
  if (!openRows().length) {
    li.innerHTML = "<p>No sync has run yet — the first scheduled run will fill this in.</p>";
    return li;
  }
  const view = state.view;
  const msg = view === "opening"
    ? "Nothing is due to open just now — this view lists roles whose previous cycle opened around today and whose opening this cycle has not been published."
    : view === "shortlist" ? "Nothing saved yet. Press <kbd>s</kbd> on a role to save it."
    : view === "applied" ? "Nothing marked applied yet. Press <kbd>a</kbd> on a role once you've applied."
    : "Nothing matches these filters.";
  li.innerHTML = `<p>${msg}</p>`;
  const b = document.createElement("button");
  b.className = "ghost tiny";
  b.textContent = view === "shortlist" || view === "applied" ? "Browse everything" : "Clear filters";
  b.addEventListener("click", () => {
    if (view === "shortlist" || view === "applied") setView("all"); else resetFilters();
  });
  li.appendChild(b);
  return li;
}

function filtered() {
  let out = openRows();

  // The view is the primary filter; everything else narrows within it.
  const st = (r) => markOf(r.key).status;
  if (state.view === "curated") out = out.filter((r) => r.curated && st(r) !== "dismissed");
  else if (state.view === "targets") out = out.filter((r) => r.is_target && st(r) !== "dismissed");
  else if (state.view === "new") out = out.filter((r) => r.is_new && st(r) !== "dismissed");
  else if (state.view === "closing") {
    out = out.filter((r) => r.closes_in_days != null && r.closes_in_days >= 0
      && r.closes_in_days <= 14 && st(r) !== "dismissed");
  } else if (state.view === "opening") {
    out = out.filter((r) => r.opening_window && st(r) !== "dismissed");
  } else if (state.view === "shortlist") out = out.filter((r) => st(r) === "shortlist");
  else if (state.view === "applied") out = out.filter((r) => st(r) === "applied");
  // "all" shows everything, dismissed included, so nothing is unrecoverable.

  if (state.scotOnly) out = out.filter((r) => ["scotland", "remote"].includes(r.location_class));
  if (state.types.size) out = out.filter((r) => state.types.has(r.type));
  if (state.seasons.size) out = out.filter((r) => state.seasons.has(r.season || "undated"));
  if (state.within != null) {
    out = out.filter((r) => r.closes_in_days != null
      && r.closes_in_days <= state.within && r.closes_in_days >= 0);
  }
  const q = state.q.trim().toLowerCase();
  if (q) {
    // Also compare with punctuation and spaces stripped, so "jpmorgan", "jp morgan"
    // and "J.P. Morgan" are the same search. Trackr's company names are punctuated
    // inconsistently and a plain substring match silently returns nothing.
    const qz = squash(q);
    out = out.filter((r) => {
      const hay = (r.company + " " + (r.target_name || "") + " " + r.title + " " +
        (r.role_categories || []).join(" ") + " " +
        (r.locations || []).join(" ")).toLowerCase();
      return hay.includes(q) || (qz && squash(hay).includes(qz));
    });
  }

  const big = 1e9;
  const val = {
    rank: (r) => r.rank_score,
    match: (r) => r.match_score,
    company: (r) => r.company.toLowerCase(),
    deadline: (r) => (r.closes_in_days == null ? big : r.closes_in_days),
    opening: (r) => r.opening_date || "",
    due: (r) => (r.opens_around_days == null ? big : r.opens_around_days),
  }[state.sortKey] || ((r) => r.rank_score);

  // Score-like keys read best highest-first; these two read best lowest-first, so
  // the default direction flips for them.
  const ascNatural = ["deadline", "company", "due"].includes(state.sortKey);
  const dir = ascNatural ? -state.sortDir : state.sortDir;
  return out.slice().sort((a, b) => {
    const x = val(a), y = val(b);
    if (x < y) return -dir;
    if (x > y) return dir;
    return 0;
  });
}

function itemEl(r) {
  const li = document.createElement("li");
  const mark = markOf(r.key);
  li.className = "item";
  li.dataset.key = r.key;
  if (mark.status !== "none") li.classList.add(mark.status);

  const main = document.createElement("div");
  main.className = "item-main";
  main.innerHTML =
    `<div class="row1">` +
    `<span class="company">${r.is_target ? '<span class="star" title="Target company">★</span> ' : ""}${esc(r.company)}</span>` +
    `<span class="badge type">${esc(prettyType(r.type))}</span>` +
    (r.season ? `<span class="badge season">${esc(r.season)}</span>` : "") +
    (r.location_class && r.location_class !== "unknown"
      ? `<span class="badge loc${inferredLoc(r) ? " inferred" : ""}"` +
        ` title="${esc(locTitle(r))}">${esc(locLabel(r.location_class))}` +
        `${inferredLoc(r) ? "?" : ""}</span>` : "") +
    (r.assessment_pending
      ? `<span class="badge assess" title="You have a ${esc(r.assessment_label || "assessment")}` +
        ` booked at this company for ${esc(r.assessment_on)} — set in targets.yaml">` +
        `${esc(r.assessment_label || "assessment")} ${esc(dueLabel(r.assessment_in_days))}</span>` : "") +
    (r.is_new ? `<span class="badge new">new</span>` : "") +
    (r.opening_window && r.last_year_opening
      ? `<span class="badge due" title="Opened ${esc(dayMonth(r.last_year_opening))}` +
        ` in the previous cycle. This cycle's opening date has not been published —` +
        ` last year's date is only within a fortnight of the truth about a third of` +
        ` the time, so treat it as a nudge to check, not a countdown.">due ~${esc(dayMonth(r.last_year_opening))}</span>` : "") +
    (r.is_rolling ? `<span class="badge rolling">rolling</span>` : "") +
    (mark.status !== "none"
      ? `<span class="badge mark ${mark.status}">${esc(STATUS_LABEL[mark.status])}</span>` : "") +
    `</div>` +
    `<div class="title">` +
    (r.url ? `<a href="${esc(r.url)}" rel="noopener">${esc(r.title)}</a>` : esc(r.title)) +
    `</div>`;
  if (r.why && r.why.length) {
    const chips = document.createElement("div");
    chips.className = "chips";
    r.why.forEach((w) => {
      const s = document.createElement("span");
      s.className = "chip";
      s.textContent = w;
      chips.appendChild(s);
    });
    main.appendChild(chips);
  }
  li.appendChild(main);

  const side = document.createElement("div");
  side.className = "item-side";
  const cd = r.closes_in_days;
  const urgency = cd == null || cd < 0 ? "" : cd <= 3 ? " urgent" : cd <= 10 ? " soon" : "";
  const dl = document.createElement("span");
  dl.className = "deadline" + urgency;
  dl.innerHTML = deadlineHtml(r);
  side.appendChild(dl);

  const actions = document.createElement("div");
  actions.className = "actions";
  STATUSES.forEach((s) => {
    const b = document.createElement("button");
    b.className = "ghost" + (mark.status === s ? " on" : "");
    b.textContent = mark.status === s ? STATUS_LABEL[s] : STATUS_ACTION[s];
    b.setAttribute("aria-pressed", String(mark.status === s));
    b.addEventListener("click", () => setStatus(r.key, s));
    actions.appendChild(b);
  });
  const more = document.createElement("button");
  more.className = "ghost";
  more.textContent = expanded.has(r.key) ? "Less" : "Details";
  more.addEventListener("click", () => toggleExpand(r.key));
  actions.appendChild(more);
  side.appendChild(actions);
  li.appendChild(side);

  if (expanded.has(r.key)) li.appendChild(detailEl(r, mark));
  return li;
}

function detailEl(r, mark) {
  const d = document.createElement("div");
  d.className = "detail";

  const rows = [
    ["Locations", (r.locations || []).join(", ") ||
      (r.location_class === "unknown" ? "—" : `${locLabel(r.location_class)} — ${locTitle(r)}`)],
    ["Season", r.season || "—"],
    ["Opens", r.opening_date || (r.opens_in_days != null ? `in ${r.opens_in_days} d` : "—")],
    ["Opened last cycle", r.last_year_opening
      ? `${r.last_year_opening}${r.opens_around_days != null
          ? ` — comes round again ${dueLabel(r.opens_around_days)}` : ""}`
      : "—"],
    ["Closes", r.closing_date || (r.is_rolling ? "rolling" : "—")],
    ["CV match", `${r.match_score}${(r.match_reasons || []).length ? " — " + r.match_reasons.join(", ") : ""}`],
    ["Rank score", String(r.rank_score)],
    ["Disciplines", (r.disciplines || []).join(", ") || "—"],
    ["Needs", [r.requires_cv && "CV", r.requires_cover_letter && "cover letter",
      r.requires_written_answers && "written answers"].filter(Boolean).join(", ") || "—"],
  ];
  const dl = document.createElement("dl");
  rows.forEach(([k, v]) => {
    const dt = document.createElement("dt"); dt.textContent = k;
    const dd = document.createElement("dd"); dd.textContent = v;
    dl.append(dt, dd);
  });
  d.appendChild(dl);

  const note = document.createElement("textarea");
  note.className = "note-input";
  note.rows = 2;
  note.placeholder = "Your notes (saved in this browser)…";
  note.value = mark.note || "";
  note.addEventListener("input", () => setNote(r.key, note.value));
  d.appendChild(note);
  return d;
}

function deadlineHtml(r) {
  const d = r.closes_in_days;
  if (d != null && d >= 0) {
    const label = d === 0 ? "closes today" : `${d} day${d === 1 ? "" : "s"} left`;
    return `${label}${r.closing_date ? ` <span class="date">· ${esc(r.closing_date)}</span>` : ""}`;
  }
  if (r.closing_date) return `closed <span class="date">${esc(r.closing_date)}</span>`;
  if (r.is_rolling) return "rolling";
  return "no deadline";
}

// ---- helpers ---------------------------------------------------------------
function prettyType(t) {
  return ({
    "graduate-programmes": "Graduate",
    "off-cycle-internships": "Off-cycle",
    "summer-internships": "Summer intern",
    "industrial-placements": "Placement",
    "spring-week": "Spring week",
    "insight-programmes": "Insight",
  })[t] || t;
}
/* "2026-09-14" -> "14 Sep". Last cycle's opening date is quoted verbatim rather
   than projected onto this year: rolled forward it lands within a fortnight of the
   real opening only about a third of the time, so it is a prompt to go and look,
   not a date to plan around. */
function dayMonth(iso) {
  const d = new Date(iso + "T00:00:00Z");
  if (isNaN(d)) return String(iso);
  return `${d.getUTCDate()} ${["Jan", "Feb", "Mar", "Apr", "May", "Jun",
    "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][d.getUTCMonth()]}`;
}
function dueLabel(days) {
  if (days === 0) return "today";
  if (days < 0) return `${-days} day${days === -1 ? "" : "s"} ago`;
  return `in ${days} day${days === 1 ? "" : "s"}`;
}
function squash(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, "");
}
function locLabel(c) {
  return ({ scotland: "Scotland", remote: "Remote", "uk-other": "UK", intl: "Intl" })[c] || c;
}
/* Trackr leaves `locations` empty on almost every UK tech row, so most locations
   here are inferred from the employer's office rather than stated for the role.
   That has to be visible: a Barclays row reads "UK" off a London office whether
   the job is in Glasgow or Knutsford. */
function inferredLoc(r) {
  return r.location_source === "company-office";
}
function locTitle(r) {
  return ({
    listed: "location listed for this role",
    url: "city taken from the employer's job URL",
    "company-office": "inferred from the employer's UK office — not stated for this role",
  })[r.location_source] || "no location information";
}
function shortStamp(iso) {
  return String(iso).replace("T", " ").replace(/:\d\d(\.\d+)?(Z|[+-]\d\d:?\d\d)?$/, "");
}
function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (m) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m]));
}
