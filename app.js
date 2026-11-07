"use strict";

/* Grad Tech Dashboard.
   Static page over two JSON files: data/opportunities.json (the curated feed) and
   data/practice-today.json (the coach's plan). Everything personal — saved roles,
   notes, ticked problems — lives in localStorage and never leaves the browser. */

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

const VIEWS = ["curated", "targets", "closing", "opening", "new", "shortlist", "pipeline", "all"];
/* "applied" used to be one of these local marks. It is now a pipeline stage in
   applications.yaml instead — a single yes/no flag could not tell "submitted and
   waiting" from "OA due Sunday", which is the whole question the board answers.
   Legacy marks with status "applied" are ignored rather than migrated. */
const STATUSES = ["shortlist", "dismissed"];
const STATUS_LABEL = { shortlist: "Saved", dismissed: "Dismissed" };
const STATUS_ACTION = { shortlist: "Save", dismissed: "Dismiss" };
// How many extra problems the "More practice" button reveals per press.
const MORE_STEP = 2;

/* The pipeline vocabulary, mirroring STAGE_ORDER in src/trackrjobs/applications.py.
   Kept literal rather than read from the feed so the picker still works against an
   older opportunities.json, and checked against the feed at load time so the two
   drifting apart is loud instead of silent. */
const STAGE_ORDER = ["interested", "applying", "applied", "oa", "interview", "final", "offer"];
const CLOSED_STAGES = ["rejected", "withdrawn"];
const STAGE_LABEL = {
  interested: "Interested", applying: "Writing it", applied: "Applied",
  oa: "Online assessment", interview: "Interview", final: "Final round",
  offer: "Offer", rejected: "Rejected", withdrawn: "Withdrawn",
};

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
  /* Stage changes made on this device but not yet written back to
     applications.yaml, keyed by appKey(). They render immediately — the board is
     useless if updating it is a round trip through a terminal — but the committed
     file stays the record, and #stagebar is what stops a pending change being
     forgotten. */
  stageEdits: {},
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
  state.stageEdits = store.get("gtd-stage-edits", {});
  readHash();
  checkStageVocabulary();

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
  if (e.key >= "1" && e.key <= "8") { setView(VIEWS[Number(e.key) - 1]); return; }

  const max = state.rows.length - 1;
  if (e.key === "j" || e.key === "ArrowDown") { moveCursor(Math.min(max, state.cursor + 1)); e.preventDefault(); }
  else if (e.key === "k" || e.key === "ArrowUp") { moveCursor(Math.max(0, state.cursor - 1)); e.preventDefault(); }
  else if (state.cursor >= 0) {
    const row = state.rows[state.cursor];
    if (!row) return;
    if (e.key === "Enter" && row.url) window.open(row.url, "_blank", "noopener");
    else if (e.key === "s") setStatus(row.key, "shortlist");
    else if (e.key === "a") advanceStage(row);
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

/* ---- pipeline ------------------------------------------------------------
   The board answers the question the job list never could: what have I got
   running, and whose move is it. Its record is applications.yaml, which reaches
   here inside the feed as `pipeline`; the picker below writes local overrides on
   top and hands back the command that makes them permanent.

   Local-only would have been half a feature — the email digest, the ranking and
   the practice coach all read the committed file, and a stage only this browser
   knows about reaches none of them. */

const NO_STAGE = "";

/* Which application a row belongs to. Company plus role, because a company can
   have several live applications (JPMorgan's Software Engineer Program and Data &
   AI are separate processes on one company id) and they must not share a stage.

   A matched row carries `application_key`, computed once by the generator, and that
   is always preferred: the two files spell companies differently — Trackr says
   "J.P. Morgan" where applications.yaml says "JPMorgan Chase" — so a key rebuilt
   here from the row's own name would miss, and changing the stage on a JPMorgan
   card would add a second board entry instead of moving the first.

   An untracked row has no key yet, so one is built from the name `trackrjobs stage`
   will actually be given (targets.yaml's spelling where there is one) plus its own
   title, which is exactly the application being created. */
function appKey(r) {
  if (r.application_key) return r.application_key;
  const role = r.application_role || r.title || "";
  return squash(r.target_name || r.company) + "|" + squash(role);
}

function appKeyOf(app) {
  return app.key || (squash(app.company) + "|" + squash(app.role || ""));
}

function pipelineFeed() {
  return (state.feed && state.feed.pipeline) || { applications: [], counts: {}, stages: [] };
}

/* A vocabulary the page and the generator disagree about would mislabel every
   card, so say so rather than rendering a wrong word confidently. */
function checkStageVocabulary() {
  const fromFeed = (pipelineFeed().stages || []).map((s) => s.id);
  if (!fromFeed.length) return;
  const mine = STAGE_ORDER.concat(CLOSED_STAGES);
  const missing = fromFeed.filter((id) => !mine.includes(id));
  if (missing.length) console.warn("app.js is missing pipeline stages:", missing);
}

// The stage a row is at right now, pending edits included. "" means untracked.
function stageOf(r) {
  const edit = state.stageEdits[appKey(r)];
  if (edit) return edit.stage;
  return r.application_stage || NO_STAGE;
}

function stageLabel(stage) {
  return STAGE_LABEL[stage] || stage;
}

function isClosedStage(stage) {
  return CLOSED_STAGES.includes(stage);
}

function setStage(r, stage) {
  const key = appKey(r);
  if (stage === (r.application_stage || NO_STAGE)) {
    delete state.stageEdits[key];       // back to what the file says — not a change
  } else {
    state.stageEdits[key] = {
      stage,
      company: r.company,
      // The name targets.yaml uses, when there is one: that is the spelling
      // `trackrjobs stage` will resolve, and the one Sean actually types.
      command_company: r.target_name || r.company,
      role: r.application_role || r.title || "",
      was: r.application_stage || NO_STAGE,
      at: new Date().toISOString().slice(0, 10),
    };
  }
  store.set("gtd-stage-edits", state.stageEdits);
  render();
}

/* Press `a` to move one along rather than opening the picker — the overwhelmingly
   common edit is "it went to the next thing". An untracked row starts at
   "applied", which is what pressing `a` used to mean. */
function advanceStage(r) {
  const cur = stageOf(r);
  if (!cur) return setStage(r, "applied");
  if (isClosedStage(cur)) return setStage(r, NO_STAGE);
  const i = STAGE_ORDER.indexOf(cur);
  setStage(r, STAGE_ORDER[Math.min(i + 1, STAGE_ORDER.length - 1)]);
}

function stageCommand(edit) {
  const role = edit.role ? ` --role ${JSON.stringify(edit.role)}` : "";
  return `uv run trackrjobs stage ${JSON.stringify(edit.command_company)} ${edit.stage}${role}`;
}

/* The board, merging the committed applications with anything edited here. An
   edit on a row the file does not know about becomes a new entry — otherwise
   marking an untracked role "applied" would vanish until it was committed. */
function pipelineRows() {
  const byKey = new Map();
  (pipelineFeed().applications || []).forEach((a) => {
    byKey.set(appKeyOf(a), { ...a, key: appKeyOf(a), pending: false });
  });
  Object.entries(state.stageEdits).forEach(([key, edit]) => {
    const existing = byKey.get(key);
    if (existing) {
      byKey.set(key, {
        ...existing,
        stage: edit.stage,
        stage_label: stageLabel(edit.stage),
        is_live: !isClosedStage(edit.stage),
        is_closed: isClosedStage(edit.stage),
        // A stage that moved makes the old stage's due date and next action stale.
        // Showing them against the new stage would assert something nobody said.
        needs_action: STAGE_ORDER.indexOf(edit.stage) < STAGE_ORDER.indexOf("applied"),
        due: null, due_in_days: null, due_label: "", next_action: "",
        pending: true,
      });
    } else {
      byKey.set(key, {
        key, company: edit.command_company || edit.company, role: edit.role,
        stage: edit.stage,
        stage_label: stageLabel(edit.stage),
        is_live: !isClosedStage(edit.stage), is_closed: isClosedStage(edit.stage),
        needs_action: true, due: null, due_in_days: null, due_label: "",
        next_action: "", note: "", pending: true,
      });
    }
  });
  const rows = Array.from(byKey.values());
  const big = 1e9;
  return rows.sort((a, b) => {
    const ac = a.is_closed ? 1 : 0, bc = b.is_closed ? 1 : 0;
    if (ac !== bc) return ac - bc;
    const ad = a.due_in_days != null && a.due_in_days >= 0 ? a.due_in_days : big;
    const bd = b.due_in_days != null && b.due_in_days >= 0 ? b.due_in_days : big;
    if (ad !== bd) return ad - bd;
    const ai = STAGE_ORDER.indexOf(a.stage), bi = STAGE_ORDER.indexOf(b.stage);
    if (ai !== bi) return bi - ai;
    return String(a.company).localeCompare(String(b.company));
  });
}

/* The unsaved-changes bar. Deliberately loud and deliberately not dismissible by
   accident: a stage that never reaches applications.yaml is invisible to the
   digest, the ranking and the coach, which is most of what the stage was for. */
function renderStageBar() {
  const box = $("#stagebar");
  const edits = Object.entries(state.stageEdits);
  box.textContent = "";
  if (!edits.length) { box.hidden = true; return; }
  box.hidden = false;

  const head = document.createElement("div");
  head.className = "stagebar-head";
  head.innerHTML =
    `<strong>${edits.length} stage change${edits.length === 1 ? "" : "s"} on this device only.</strong> ` +
    `Run the command to put ${edits.length === 1 ? "it" : "them"} in ` +
    `<code>applications.yaml</code> — until then the digest, the ranking and the ` +
    `coach still see the old stage.`;
  box.appendChild(head);

  const list = document.createElement("ul");
  list.className = "stagebar-list";
  edits.forEach(([key, edit]) => {
    const li = document.createElement("li");
    const from = edit.was ? stageLabel(edit.was) : "untracked";
    const txt = document.createElement("span");
    txt.className = "stagebar-what";
    txt.textContent = `${edit.company}${edit.role ? " — " + edit.role : ""}: ` +
      `${from} → ${stageLabel(edit.stage)}`;
    li.appendChild(txt);

    const copy = document.createElement("button");
    copy.className = "ghost tiny";
    copy.textContent = "Copy command";
    copy.addEventListener("click", () => {
      navigator.clipboard?.writeText(stageCommand(edit));
      copy.textContent = "copied";
      setTimeout(() => { copy.textContent = "Copy command"; }, 1200);
    });
    li.appendChild(copy);

    const undo = document.createElement("button");
    undo.className = "linkbtn";
    undo.textContent = "undo";
    undo.addEventListener("click", () => {
      delete state.stageEdits[key];
      store.set("gtd-stage-edits", state.stageEdits);
      render();
    });
    li.appendChild(undo);
    list.appendChild(li);
  });
  box.appendChild(list);

  const all = document.createElement("button");
  all.className = "ghost tiny";
  all.textContent = `Copy all ${edits.length}`;
  all.addEventListener("click", () => {
    navigator.clipboard?.writeText(edits.map(([, e]) => stageCommand(e)).join("\n"));
    all.textContent = "copied";
    setTimeout(() => { all.textContent = `Copy all ${edits.length}`; }, 1200);
  });
  box.appendChild(all);

  const done = document.createElement("button");
  done.className = "linkbtn";
  done.textContent = "I've run them — clear";
  done.title = "Clears the pending list. The next `trackrjobs curate` rebuilds the " +
    "feed from applications.yaml, so the stages come back from the file.";
  done.addEventListener("click", () => {
    state.stageEdits = {};
    store.set("gtd-stage-edits", state.stageEdits);
    render();
  });
  box.appendChild(done);
}

function stageSelectEl(r) {
  const wrap = document.createElement("label");
  wrap.className = "stagepick";
  const cur = stageOf(r);
  wrap.innerHTML = '<span class="vh">Application stage</span>';

  const sel = document.createElement("select");
  sel.title = "Where this application stands. Saved to applications.yaml with the " +
    "command the bar gives you.";
  const none = document.createElement("option");
  none.value = NO_STAGE;
  none.textContent = "Not applied";
  sel.appendChild(none);
  STAGE_ORDER.concat(CLOSED_STAGES).forEach((st) => {
    const o = document.createElement("option");
    o.value = st;
    o.textContent = STAGE_LABEL[st];
    sel.appendChild(o);
  });
  sel.value = cur;
  sel.addEventListener("change", () => setStage(r, sel.value));
  wrap.appendChild(sel);
  if (state.stageEdits[appKey(r)]) wrap.classList.add("pending");
  return wrap;
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
   day-by-day plan rather than a chip. Driven by targets.yaml `assessment_on:`, or
   by `assessment_invited:` when the invite named no sit-by date — that gets the same
   panel minus the countdown and the red clock, because there is no date to count to
   and guessing one here would dress an assumption up as the one thing on this page
   that isn't. */
function renderAssessment() {
  const a = state.practice && state.practice.assessment;
  const panel = $("#assessment");
  if (!a) { panel.hidden = true; return; }
  panel.hidden = false;

  $("#assessTitle").textContent = `${a.company} ${a.label}`;
  const due = $("#assessDue");
  due.textContent = a.due_label;
  // `in_days` is null for an undated invite, and `null <= 1` is true in JS — which
  // would paint "still to sit" in the same red as "sit it today".
  due.className = "pip " + (a.in_days == null ? ""
    : a.in_days <= 1 ? "hot" : a.in_days <= 3 ? "warm" : "");

  const body = $("#assessment-body");
  body.textContent = "";

  const head = document.createElement("div");
  head.className = "assess-head";
  // Only print a shape the invite actually stated. `questions` and `duration_min`
  // are null when it did not, and an assumed "90 min" here would read as fact.
  const shape = a.questions && a.duration_min
    ? `${a.questions} question${a.questions === 1 ? "" : "s"} · ${a.duration_min} min`
    : a.duration_min ? `${a.duration_min} min` : "";
  head.innerHTML =
    `<div class="when">${esc(a.date_label)} · <strong>${esc(a.platform)}</strong>` +
    (shape ? ` · ${esc(shape)}` : "") + `</div>` +
    (a.style ? `<div class="how">${esc(a.style)}</div>` : "");
  body.appendChild(head);

  /* Parts of the same assessment that no problem list prepares you for — Optiver
     pairs its coding question with the Zap-N game battery. They sit above the
     countdown because forgetting one is the expensive mistake: the countdown is
     about getting better, this is about not being blindsided on the day. */
  (a.extra_components || []).forEach((c) => {
    const d = document.createElement("div");
    d.className = "assess-note extra";
    d.innerHTML = `<strong>${esc(c.name)}</strong>` +
      (c.detail ? ` — ${esc(c.detail)}` : "") +
      (c.prep ? `<span class="extra-prep">${esc(c.prep)}</span>` : "");
    body.appendChild(d);
  });

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

  // With a date there is a schedule; without one there is only a queue. The panel
  // must still answer "what do I do about this today", which the countdown's own
  // today row normally carries.
  body.appendChild((a.countdown || []).length ? countdownEl(a) : queueEl(a));

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

/* The undated stand-in for the countdown: this company's queued problems, next
   unsolved first, in the same shape as a countdown drill day so the styling and the
   tick state carry over. Deliberately NOT a schedule — there is no date to build one
   against, and spreading the queue across invented days would be a forecast. */
function queueEl(a, n = 5) {
  const ol = document.createElement("ol");
  ol.className = "countdown";
  const li = document.createElement("li");
  li.className = "cd drill today";

  const head = document.createElement("div");
  head.className = "cd-head";
  head.innerHTML = `<span class="cd-day">Next up</span><span class="cd-kind">drill</span>`;
  li.appendChild(head);

  const task = document.createElement("p");
  task.className = "cd-task";
  task.textContent = a.today_task || "";
  li.appendChild(task);

  const queued = (a.problems || []).filter((q) => !(state.solved[q.slug] || q.done));
  if (queued.length) {
    const ul = document.createElement("ul");
    ul.className = "cd-probs";
    queued.slice(0, n).forEach((q) => {
      const item = document.createElement("li");
      item.innerHTML =
        `<a href="${esc(q.url || q.neetcode_url)}" rel="noopener">${esc(q.name)}</a>` +
        `<span class="cd-meta">${esc(q.difficulty)} · ~${q.est_minutes}m</span>`;
      ul.appendChild(item);
    });
    li.appendChild(ul);
  }
  ol.appendChild(li);
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
  renderStageBar();
  if (state.view === "pipeline") { renderBoard(); return; }

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
    // The board counts applications, not listings: three JPMorgan rows are one
    // application, and an application can outlive the listing it came from.
    pipeline: pipelineRows().filter((a) => a.is_live).length,
    all: open.length,
  };
}

function pipelineCounts() {
  const rows = pipelineRows();
  const live = rows.filter((a) => a.is_live);
  return {
    live: live.length,
    mine: live.filter((a) => a.needs_action).length,
    theirs: live.filter((a) => !a.needs_action).length,
    closed: rows.filter((a) => a.is_closed).length,
  };
}

function renderStats() {
  const c = counts();
  const pc = pipelineCounts();
  const tiles = [
    { view: "curated", n: c.curated, label: "worth a look" },
    { view: "targets", n: c.targets, label: "at target companies" },
    { view: "closing", n: c.closing, label: "closing ≤14 days", cls: c.closing ? "urgent" : "" },
    { view: "opening", n: c.opening, label: "due to open" },
    { view: "new", n: c.new, label: "new this week", cls: c.new ? "good" : "" },
    { view: "pipeline", n: pc.mine, label: "waiting on you",
      cls: pc.mine ? "urgent" : "" },
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
    : "Nothing matches these filters.";
  li.innerHTML = `<p>${msg}</p>`;
  const b = document.createElement("button");
  b.className = "ghost tiny";
  b.textContent = view === "shortlist" ? "Browse everything" : "Clear filters";
  b.addEventListener("click", () => {
    if (view === "shortlist") setView("all"); else resetFilters();
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
  // "all" shows everything, dismissed included, so nothing is unrecoverable.
  // "pipeline" never reaches here — it renders a board rather than filtering rows.

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

/* ---- the board ------------------------------------------------------------
   Split on whose move it is, because that is the only split that changes what you
   do today. "Waiting on you" is anything with a date you were given, a next action
   you wrote down, or nothing submitted yet; "waiting on them" is everything else
   that is live. A board where all five look equally urgent is just a list. */
function renderBoard() {
  // The cursor indexes `state.rows`, which are opportunity rows. Leaving the
  // previous view's rows in place would point j/k — and Enter, and `s` — at
  // whatever was on screen before.
  state.rows = [];
  state.cursor = -1;
  renderStats();
  renderTabs();
  $("#activeFilters").hidden = true;
  $("#count").textContent = "";

  const rows = pipelineRows();
  const c = pipelineCounts();
  const list = $("#list");
  list.textContent = "";

  if (!rows.length) {
    const li = document.createElement("li");
    li.className = "empty";
    li.innerHTML = "<p>Nothing in the pipeline yet. Set a stage on any role " +
      "(the dropdown on its card, or press <kbd>a</kbd>) — or add it directly in " +
      "<code>applications.yaml</code>.</p>";
    list.appendChild(li);
    return;
  }

  $("#count").textContent =
    `${c.live} live · ${c.mine} waiting on you · ${c.theirs} waiting on them` +
    (c.closed ? ` · ${c.closed} closed` : "");

  const groups = [
    ["Waiting on you", rows.filter((a) => a.is_live && a.needs_action),
     "A date you were given, or a next step you wrote down."],
    ["Waiting on them", rows.filter((a) => a.is_live && !a.needs_action),
     "Submitted, nothing owed — check the days-in-stage before chasing."],
    ["Closed", rows.filter((a) => a.is_closed),
     "Kept for the record."],
  ];
  const frag = document.createDocumentFragment();
  groups.forEach(([title, items, hint]) => {
    if (!items.length) return;
    const head = document.createElement("li");
    head.className = "boardhead";
    head.innerHTML = `<span class="bh-title">${esc(title)}</span>` +
      `<span class="bh-n">${items.length}</span>` +
      `<span class="bh-hint">${esc(hint)}</span>`;
    frag.appendChild(head);
    items.forEach((a) => frag.appendChild(boardItemEl(a)));
  });
  list.appendChild(frag);
}

function boardItemEl(a) {
  const li = document.createElement("li");
  li.className = "item board" + (a.is_closed ? " closed" : "") + (a.pending ? " pending" : "");

  // The live listing behind this application, when the feed still carries one. An
  // application can outlive its listing, so this is a bonus, never a requirement.
  const row = (state.feed.opportunities || []).find((r) =>
    r.application_key === appKeyOf(a) && r.status === "open");

  const main = document.createElement("div");
  main.className = "item-main";
  const d = a.due_in_days;
  main.innerHTML =
    `<div class="row1">` +
    `<span class="company">${esc(a.company)}</span>` +
    `<span class="badge stage ${esc(a.stage)}">${esc(a.stage_label)}</span>` +
    (a.pending ? `<span class="badge mark pendingmark" title="Changed here, not yet in applications.yaml">unsaved</span>` : "") +
    (d != null
      ? `<span class="badge ${d < 0 ? "assess" : d <= 3 ? "assess" : "due"}">` +
        `${esc(a.due_label || "due")} ${esc(d < 0 ? `${-d} days ago` : dueLabel(d))}</span>`
      : "") +
    `</div>` +
    `<div class="title">` +
    (row && row.url ? `<a href="${esc(row.url)}" rel="noopener">${esc(a.role || row.title)}</a>`
      : esc(a.role || "—")) +
    `</div>`;

  if (a.next_action) {
    const p = document.createElement("p");
    p.className = "boardnext";
    p.textContent = a.next_action;
    main.appendChild(p);
  }
  if (a.note) {
    const det = document.createElement("details");
    det.className = "notes";
    const sum = document.createElement("summary");
    sum.textContent = "Notes";
    det.appendChild(sum);
    const nd = document.createElement("div");
    nd.className = "note";
    nd.textContent = a.note;
    det.appendChild(nd);
    main.appendChild(det);
  }
  li.appendChild(main);

  const side = document.createElement("div");
  side.className = "item-side";
  const meta = document.createElement("span");
  meta.className = "deadline" + (d != null && d >= 0 && d <= 3 ? " urgent" : "");
  meta.innerHTML = d != null
    ? `${esc(d < 0 ? "overdue" : dueLabel(d))}${a.due ? ` <span class="date">· ${esc(a.due)}</span>` : ""}`
    : (a.days_in_stage != null
      ? `<span class="date">${a.days_in_stage} day${a.days_in_stage === 1 ? "" : "s"} at this stage</span>`
      : "");
  side.appendChild(meta);

  // The picker needs a row-shaped object; a board entry is keyed the same way.
  side.appendChild(stageSelectEl({
    application_key: appKeyOf(a),
    company: a.company, title: a.role, application_role: a.role,
    // What the FILE says, so choosing that value again clears the pending edit
    // rather than recording a change from the change.
    application_stage: a.pending ? (state.stageEdits[appKeyOf(a)].was || "") : a.stage,
    target_name: a.company,
  }));
  li.appendChild(side);
  return li;
}

function itemEl(r) {
  const li = document.createElement("li");
  const mark = markOf(r.key);
  li.className = "item";
  li.dataset.key = r.key;
  if (mark.status !== "none") li.classList.add(mark.status);
  const st = stageOf(r);
  if (st && !isClosedStage(st)) li.classList.add("inflight");
  if (st && isClosedStage(st)) li.classList.add("dismissed");

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
        ` to sit at this company${r.assessment_on ? `, by ${esc(r.assessment_on)}` : ""}` +
        ` — set in targets.yaml">` +
        `${esc(r.assessment_label || "assessment")} ` +
        `${esc(r.assessment_in_days == null ? "to sit" : dueLabel(r.assessment_in_days))}</span>` : "") +
    (stageOf(r)
      ? `<span class="badge stage ${esc(stageOf(r))}"` +
        ` title="Where this application stands — applications.yaml">` +
        `${esc(stageLabel(stageOf(r)))}</span>` +
        (state.stageEdits[appKey(r)]
          ? `<span class="badge mark pendingmark" title="Changed here, not yet in applications.yaml">unsaved</span>` : "")
      : "") +
    (r.application_due_in_days != null && !state.stageEdits[appKey(r)]
      ? `<span class="badge assess" title="${esc(r.application_due_label || "this stage")}` +
        ` is due ${esc(r.application_due || "")} — applications.yaml">` +
        `${esc(r.application_due_label || "due")} ` +
        `${esc(r.application_due_in_days < 0 ? "overdue" : dueLabel(r.application_due_in_days))}</span>`
      : "") +
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
  // Where this application stands. On every card, not just tracked ones — setting
  // a stage is how a role *enters* the pipeline.
  side.appendChild(stageSelectEl(r));
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
    ["Stage", stageOf(r)
      ? stageLabel(stageOf(r)) +
        (r.application_due ? ` — ${r.application_due_label || "due"} ${r.application_due}` : "") +
        (state.stageEdits[appKey(r)] ? " (unsaved on this device)" : "")
      : "not applied"],
    ["Next action", r.application_next_action || "—"],
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
