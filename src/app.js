import { marked } from "../vendor/marked.esm.js";
import { GitHubSource, LocalSource, ConflictError } from "./source.js";
import { PdfView } from "./pdfview.js";
import { parseThread, newThreadText, appendQuestion, nowStamp } from "./thread.js";

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const CFG_KEY = "paper-reader.config";
const LAST_KEY = "paper-reader.paper";
const ASK_TEXT = "paper-reader-data の未回答スレッドに答えて（CLAUDE.md の手順どおり，引用照合をして main に push）";

const state = {
  cfg: null, src: null, papers: [], paperId: null, meta: null,
  threads: new Map(), // id -> {id, path, sha, raw, meta, sections, open}
  filter: "all", pageFilter: null, query: "", detail: null, tab: "pdf",
  draft: null, // 新規質問の {anchor, parent}
};

let toastTimer;
function toast(msg, ms = 2500) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), ms);
}

// 失敗は消えない帯で表示する（スマホでは開発者ツールが見られないため）
function showError(msg) {
  const e = $("#err");
  e.querySelector("span").textContent = msg;
  e.hidden = false;
  $("#toast").classList.remove("show");
}
$("#err button").onclick = () => ($("#err").hidden = true);
window.addEventListener("unhandledrejection", (e) => showError(`エラー：${e.reason?.message || e.reason}`));
window.addEventListener("error", (e) => showError(`エラー：${e.message}`));

const pdf = new PdfView($("#pdf"), { onBadge: (n) => { state.pageFilter = n; showTab("threads"); closeDetail(false); renderList(); } });

// ---------- 設定 ----------
function loadCfg() {
  try { return JSON.parse(localStorage.getItem(CFG_KEY)); } catch { return null; }
}
function makeSource(cfg) {
  if (cfg?.mode === "local") return new LocalSource();
  if (cfg?.mode === "github" && cfg.token && cfg.repo) return new GitHubSource(cfg);
  return null;
}
function openSettings() {
  const f = $("#settings-form");
  const c = state.cfg || {};
  const isLocal = location.hostname === "localhost" || location.hostname === "127.0.0.1";
  f.mode.value = c.mode || (isLocal ? "local" : "github");
  f.repo.value = c.repo || "Sohei-sit/paper-reader-data";
  f.branch.value = c.branch || "main";
  f.token.value = c.token || "";
  $("#settings-dlg").showModal();
}
$("#settings-dlg").addEventListener("close", async () => {
  if ($("#settings-dlg").returnValue !== "ok") return;
  const f = $("#settings-form");
  state.cfg = { mode: f.mode.value, repo: f.repo.value.trim(), branch: f.branch.value.trim() || "main", token: f.token.value.trim() };
  try { localStorage.setItem(CFG_KEY, JSON.stringify(state.cfg)); } catch { toast("設定を保存できませんでした"); }
  await start();
});
$("#settings-btn").onclick = openSettings;

// ---------- 読み込み ----------
async function start() {
  state.src = makeSource(state.cfg);
  if (!state.src) { openSettings(); return; }
  try {
    const dirs = (await state.src.list("papers")).filter((x) => x.type === "dir");
    state.papers = [];
    for (const d of dirs) {
      try {
        const { text } = await state.src.readText(`papers/${d.name}/meta.json`);
        state.papers.push({ id: d.name, ...JSON.parse(text) });
      } catch { state.papers.push({ id: d.name, short: d.name }); }
    }
    if (!state.papers.length) { toast("papers/ に論文がありません"); return; }
    const sel = $("#paper");
    sel.innerHTML = state.papers.map((p) => `<option value="${esc(p.id)}">${esc(p.short || p.title || p.id)}</option>`).join("");
    let last = null;
    try { last = localStorage.getItem(LAST_KEY); } catch {}
    const id = state.papers.some((p) => p.id === last) ? last : state.papers[0].id;
    sel.value = id;
    await openPaper(id);
  } catch (e) {
    console.error(e);
    showError(`読み込み失敗：${e.message}`);
  }
}

async function openPaper(id) {
  state.paperId = id;
  state.meta = state.papers.find((p) => p.id === id);
  state.pageFilter = null;
  closeDetail(false);
  try { localStorage.setItem(LAST_KEY, id); } catch {}
  toast("読み込み中…", 10000);
  $("#err").hidden = true;
  const [buf] = await Promise.all([state.src.readBinary(`papers/${id}/paper.pdf`), loadThreads()]);
  try { await pdf.load(buf); }
  catch (e) { throw new Error(`PDFを表示できません（${e.message}）`); }
  refreshBadges();
  toast("読み込み完了", 1200);
}
$("#paper").onchange = (e) => openPaper(e.target.value).catch((err) => showError(`読み込み失敗：${err.message}`));

async function loadThreads() {
  const dir = `papers/${state.paperId}/threads`;
  const files = (await state.src.list(dir)).filter((f) => f.type === "file" && /^\d+\.md$/.test(f.name));
  const out = new Map();
  // 同時接続を抑えて取得
  const queue = [...files];
  await Promise.all(Array.from({ length: 6 }, async () => {
    while (queue.length) {
      const f = queue.shift();
      const { text, sha } = await state.src.readText(`${dir}/${f.name}`);
      const t = parseThread(text);
      const tid = String(t.meta.id || f.name.replace(/\.md$/, ""));
      out.set(tid, { id: tid, path: `${dir}/${f.name}`, sha, raw: text, ...t });
    }
  }));
  state.threads = out;
  renderList();
  if (state.detail) renderDetail(state.detail);
}

async function reload() {
  if (!state.src || !state.paperId) return start();
  try { await loadThreads(); refreshBadges(); toast("更新しました", 1200); }
  catch (e) { showError(`更新失敗：${e.message}`); }
}
$("#reload").onclick = reload;
// Claude アプリから戻ってきたときに自動更新
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && state.paperId) reload(); });

function refreshBadges() {
  const counts = new Map();
  for (const t of state.threads.values()) {
    const p = Number(t.meta.anchor_page);
    if (p) counts.set(p, (counts.get(p) || 0) + 1);
  }
  pdf.setBadges(counts);
  const open = [...state.threads.values()].filter((t) => t.open).length;
  const c = $("#open-count");
  c.hidden = !open;
  c.textContent = open;
}

// ---------- タブ ----------
function showTab(tab) {
  state.tab = tab;
  document.querySelectorAll(".tabs button").forEach((b) => b.classList.toggle("on", b.dataset.tab === tab));
  $("#pdf-pane").classList.toggle("on", tab === "pdf");
  $("#threads-pane").classList.toggle("on", tab === "threads");
  if (tab === "pdf") pdf.relayout();
}
document.querySelectorAll(".tabs button").forEach((b) => (b.onclick = () => showTab(b.dataset.tab)));
const isWide = () => matchMedia("(min-width: 900px)").matches;

// ---------- 一覧 ----------
function sortedThreads() {
  return [...state.threads.values()].sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));
}
function matches(t) {
  if (state.filter === "open" && !t.open) return false;
  if (state.filter === "answered" && t.open) return false;
  if (state.pageFilter && Number(t.meta.anchor_page) !== state.pageFilter) return false;
  if (state.query) {
    const q = state.query.toLowerCase();
    const hay = `${t.meta.title} ${t.raw}`.toLowerCase();
    if (!hay.includes(q)) return false;
  }
  return true;
}
function itemHTML(t) {
  const qn = t.sections.filter((s) => s.kind === "Q").length;
  const anchor = t.meta.anchor_page ? ` ・ p.${esc(t.meta.anchor_page)}` : "";
  return `<button class="titem" data-id="${esc(t.id)}">
    <div class="t"><span class="st ${t.open ? "open" : "answered"}">${t.open ? "未回答" : "回答済"}</span>${esc(t.meta.title || "(無題)")}</div>
    <div class="m">#${esc(t.id)}${anchor} ・ 質問 ${qn} ・ ${esc(String(t.meta.created || "").replace("T", " "))}</div>
  </button>`;
}
function renderList() {
  const all = sortedThreads();
  const filtered = state.filter !== "all" || state.pageFilter || state.query;
  const pf = $("#page-filter");
  pf.hidden = !state.pageFilter;
  pf.textContent = `p.${state.pageFilter} ✕`;
  let html;
  if (filtered) {
    const list = all.filter(matches);
    html = list.length ? `<ul>${list.map((t) => `<li>${itemHTML(t)}</li>`).join("")}</ul>` : "";
  } else {
    const kids = new Map();
    const roots = [];
    for (const t of all) {
      const p = t.meta.parent && state.threads.has(String(t.meta.parent)) ? String(t.meta.parent) : null;
      if (p && p !== t.id) { if (!kids.has(p)) kids.set(p, []); kids.get(p).push(t); } else roots.push(t);
    }
    const seen = new Set();
    const walk = (t) => {
      if (seen.has(t.id)) return "";
      seen.add(t.id);
      const ch = kids.get(t.id) || [];
      return `<li>${itemHTML(t)}${ch.length ? `<ul>${ch.map(walk).join("")}</ul>` : ""}</li>`;
    };
    html = roots.length ? `<ul>${roots.map(walk).join("")}</ul>` : "";
  }
  $("#tree").innerHTML = html || `<div class="empty">${all.length ? "該当するスレッドはありません" : "まだ質問がありません．PDFで文章を選択するか「＋ 新しい質問」から始めます．"}</div>`;
  $("#tree").querySelectorAll(".titem").forEach((b) => (b.onclick = () => openDetail(b.dataset.id)));
}
document.querySelectorAll(".filters [data-filter]").forEach((b) => (b.onclick = () => {
  state.filter = b.dataset.filter;
  document.querySelectorAll(".filters [data-filter]").forEach((x) => x.classList.toggle("on", x === b));
  renderList();
}));
$("#page-filter").onclick = () => { state.pageFilter = null; renderList(); };
$("#search").oninput = (e) => { state.query = e.target.value.trim(); renderList(); };

// ---------- 詳細 ----------
function renderMarkdown(md) {
  const withCites = md.replace(/\[\[p\.(\d+)\s*\|\s*([\s\S]+?)\]\]/g, (_, p, q) => {
    const quote = q.replace(/\s+/g, " ").trim();
    const short = quote.length > 90 ? `${quote.slice(0, 90)}…` : quote;
    return `<button class="cite" data-page="${p}" data-quote="${esc(encodeURIComponent(quote))}"><b>p.${p}</b> <span>“${esc(short)}”</span></button>`;
  });
  const withTags = withCites.replace(/^(\s*(?:[-*+]\s+|\d+\.\s+)?)\[(事実|推論|不明)\]/gm, (_, pre, tag) => {
    const cls = { 事実: "fact", 推論: "infer", 不明: "unk" }[tag];
    return `${pre}<span class="tag ${cls}">${tag}</span>`;
  });
  return marked.parse(withTags, { breaks: true });
}

function openDetail(id, push = true) {
  state.detail = id;
  if (push) history.pushState({ detail: id }, "", `#t/${encodeURIComponent(id)}`);
  renderDetail(id);
  $("#threads-pane").scrollTop = 0;
}
function closeDetail(push = true) {
  if (!state.detail) return;
  state.detail = null;
  $("#detail-view").hidden = true;
  $("#list-view").hidden = false;
  if (push) history.back();
}
window.addEventListener("popstate", (e) => {
  const id = e.state?.detail;
  if (id && state.threads.has(id)) { state.detail = id; renderDetail(id); }
  else closeDetail(false);
});

function renderDetail(id) {
  const t = state.threads.get(id);
  const v = $("#detail-view");
  if (!t) { closeDetail(false); return; }
  $("#list-view").hidden = true;
  v.hidden = false;
  const parent = t.meta.parent && state.threads.get(String(t.meta.parent));
  const children = sortedThreads().filter((x) => String(x.meta.parent) === t.id);
  const anchor = t.meta.anchor_quote
    ? `<div class="anchor"><button class="cite" data-page="${esc(t.meta.anchor_page)}" data-quote="${esc(encodeURIComponent(t.meta.anchor_quote))}"><b>p.${esc(t.meta.anchor_page)}</b> <span>“${esc(t.meta.anchor_quote)}”</span></button></div>`
    : t.meta.anchor_page ? `<div class="anchor"><button class="cite" data-page="${esc(t.meta.anchor_page)}" data-quote=""><b>p.${esc(t.meta.anchor_page)}</b></button></div>` : "";
  const msgs = t.sections.map((s) => s.kind === "Q"
    ? `<div class="msg q"><div class="who">質問 ・ ${esc(s.stamp.replace("T", " "))}</div>${esc(s.body).replace(/\n/g, "<br>")}</div>`
    : `<div class="msg a"><div class="who">回答 ・ ${esc(s.stamp.replace("T", " "))}</div>${renderMarkdown(s.body)}</div>`).join("");
  v.innerHTML = `
    <button class="back">← 一覧</button>
    ${parent ? `<div class="crumbs">派生元：<button data-goto="${esc(parent.id)}">#${esc(parent.id)} ${esc(parent.meta.title)}</button></div>` : ""}
    <h2><span class="st ${t.open ? "open" : "answered"}">${t.open ? "未回答" : "回答済"}</span>#${esc(t.id)} ${esc(t.meta.title)}</h2>
    ${anchor}
    ${msgs}
    ${t.open ? `<p class="note">回答待ちです．「Claude に回答を頼む」で依頼文をコピーできます．</p>` : ""}
    ${children.length ? `<div class="children"><div class="note">派生スレッド</div>${children.map(itemHTML).join("")}</div>` : ""}
    <div class="reply">
      <textarea id="followup" rows="3" placeholder="このスレッドで追加の質問"></textarea>
      <div class="actions">
        <button id="followup-send" class="primary">追加で質問</button>
        <button id="derive">派生スレッドを作る</button>
        ${t.open ? `<button id="ask-btn2">Claude に回答を頼む</button>` : ""}
      </div>
    </div>`;
  v.querySelector(".back").onclick = () => { closeDetail(false); history.pushState({}, "", location.pathname + location.search); renderList(); };
  v.querySelectorAll("[data-goto]").forEach((b) => (b.onclick = () => openDetail(b.dataset.goto)));
  v.querySelectorAll(".titem").forEach((b) => (b.onclick = () => openDetail(b.dataset.id)));
  v.querySelector("#followup-send").onclick = () => sendFollowup(t.id);
  v.querySelector("#derive").onclick = () => openNew({ parent: t.id, anchor: pdf.selection() || lastSel });
  v.querySelector("#ask-btn2")?.addEventListener("click", askClaude);
}

// 引用ボタン（詳細・一覧どこでも）
document.addEventListener("click", async (e) => {
  const b = e.target.closest("button.cite");
  if (!b) return;
  const page = Number(b.dataset.page);
  const quote = decodeURIComponent(b.dataset.quote || "");
  if (!isWide()) showTab("pdf");
  const ok = await pdf.jumpTo(page, quote);
  if (!ok && quote) toast(`p.${page} で引用位置を特定できませんでした`, 3000);
});

// ---------- 投稿 ----------
function openNew({ parent = null, anchor = null } = {}) {
  state.draft = { parent, anchor };
  const f = $("#new-form");
  f.reset();
  const a = $("#new-anchor");
  a.hidden = !anchor;
  if (anchor) a.innerHTML = `<span class="src">p.${anchor.page}</span>${esc(anchor.quote)} <button type="button" id="drop-anchor">外す</button>`;
  $("#drop-anchor")?.addEventListener("click", () => { state.draft.anchor = null; a.hidden = true; });
  const p = $("#new-parent");
  p.hidden = !parent;
  if (parent) p.textContent = `派生元：#${parent} ${state.threads.get(parent)?.meta.title || ""}`;
  $("#new-dlg").showModal();
  f.q.focus();
}
$("#new-btn").onclick = () => openNew({ anchor: null });

$("#new-dlg").addEventListener("close", async () => {
  if ($("#new-dlg").returnValue !== "ok") return;
  const f = $("#new-form");
  const q = f.q.value.trim();
  if (!q) return;
  const { parent, anchor } = state.draft || {};
  const max = Math.max(0, ...[...state.threads.keys()].map((k) => Number(k) || 0));
  const id = String(max + 1).padStart(4, "0");
  const stamp = nowStamp();
  const title = f.title.value.trim() || q.replace(/\s+/g, " ").slice(0, 40);
  const meta = { id, title, status: "open", parent: parent || "", created: stamp };
  if (anchor) { meta.anchor_page = anchor.page; meta.anchor_quote = anchor.quote; }
  const path = `papers/${state.paperId}/threads/${id}.md`;
  const text = newThreadText(meta, q, stamp);
  try {
    toast("投稿中…", 10000);
    const { sha } = await state.src.writeText(path, text, null, `question: ${state.paperId} #${id}`);
    state.threads.set(id, { id, path, sha, raw: text, ...parseThread(text) });
    hideSelbar();
    renderList();
    refreshBadges();
    showTab("threads");
    openDetail(id);
    toast("投稿しました");
  } catch (e) {
    toast(e instanceof ConflictError ? "同じ番号のスレッドが既にあります．↻で更新してから再投稿してください" : `投稿失敗：${e.message}`, 5000);
  }
});

async function sendFollowup(id) {
  const box = $("#followup");
  const q = box.value.trim();
  if (!q) return;
  const t = state.threads.get(id);
  const write = async (raw, sha) => {
    const text = appendQuestion(raw, q, nowStamp());
    const res = await state.src.writeText(t.path, text, sha, `question: ${state.paperId} #${id} (follow-up)`);
    return { text, sha: res.sha };
  };
  try {
    toast("送信中…", 10000);
    let r;
    try { r = await write(t.raw, t.sha); }
    catch (e) {
      if (!(e instanceof ConflictError)) throw e;
      const latest = await state.src.readText(t.path); // 回答が先に入っていた場合は最新に追記
      r = await write(latest.text, latest.sha);
    }
    state.threads.set(id, { ...t, raw: r.text, sha: r.sha, ...parseThread(r.text) });
    renderDetail(id);
    renderList();
    refreshBadges();
    toast("追加しました");
  } catch (e) { toast(`送信失敗：${e.message}`, 5000); }
}

async function askClaude() {
  try { await navigator.clipboard.writeText(ASK_TEXT); toast("依頼文をコピーしました．Claude アプリの Code で貼り付けてください", 4000); }
  catch { prompt("この文をコピーして Claude Code に送ってください", ASK_TEXT); }
}
$("#ask-btn").onclick = askClaude;

// ---------- テキスト選択 → 質問 ----------
let selTimer, lastSel = null;
function hideSelbar() { $("#selbar").hidden = true; lastSel = null; }
document.addEventListener("selectionchange", () => {
  clearTimeout(selTimer);
  selTimer = setTimeout(() => {
    const s = pdf.selection();
    if (!s || s.quote.length < 3) { if (!$("#new-dlg").open) hideSelbar(); return; }
    lastSel = s;
    $("#sel-text").textContent = `p.${s.page}：${s.quote}`;
    $("#selbar").hidden = false;
  }, 250);
});
// ボタンを押した瞬間に選択が外れる端末があるので，直前の選択を使う
$("#sel-ask").addEventListener("pointerdown", (e) => e.preventDefault());
$("#sel-ask").onclick = () => {
  const s = pdf.selection() || lastSel;
  if (!s) { hideSelbar(); return; }
  openNew({ anchor: s });
};

// ---------- 拡大縮小 ----------
document.querySelectorAll("#zoom [data-z]").forEach((b) => (b.onclick = () => {
  const z = pdf.setZoom(pdf.zoom + Number(b.dataset.z) * 0.25);
  $("#zoom-v").textContent = `${Math.round(z * 100)}%`;
}));

// ---------- 起動 ----------
state.cfg = loadCfg();
if (!state.cfg && (location.hostname === "localhost" || location.hostname === "127.0.0.1")) state.cfg = { mode: "local" };
history.replaceState({}, "", location.pathname + location.search);
start();
