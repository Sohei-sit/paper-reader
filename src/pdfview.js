// PDF をページごとに縦に並べて表示する．
// - 描画は1ページずつ，画面に近いページから順に行う（重い処理を同時に走らせない）
// - 画面から離れたページは解放してメモリを抑える
// - ピンチ操作は PDF 部分だけを拡大縮小する（メニューなど画面全体は拡大しない）
import * as pdfjsLib from "../vendor/pdfjs/pdf.min.mjs";
import { locate } from "./match.js";

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL("../vendor/pdfjs/pdf.worker.min.mjs", import.meta.url).href;

const MIN_ZOOM = 0.5;
const MAX_ZOOM = 4;
const MAX_CANVAS_PIXELS = 12_000_000; // iOS のキャンバス上限（約1677万画素）より余裕をもたせる
const PREFETCH = 600; // 画面外でも先に描いておく距離(px)
const KEEP_MARGIN = 1600; // これより離れたページは解放

export class PdfView {
  constructor(root, { onBadge, onZoom, onPage } = {}) {
    this.root = root; // ページを並べる要素
    this.scroller = root.parentElement; // スクロールする要素
    Object.assign(this, { onBadge, onZoom, onPage });
    this.zoom = 1;
    this.width = 0;
    this.pages = []; // {n, page, div, vp1, state:'none'|'queued'|'rendering'|'done', gen, textLayer, promise, resolve}
    this.queue = new Set();
    this.busy = false;
    this.gesture = null;
    this.marked = [];
    this.textCache = new Map();
    this.observer = new IntersectionObserver((ents) => {
      for (const e of ents) if (e.isIntersecting) this.render(Number(e.target.dataset.page));
    }, { root: this.scroller, rootMargin: `${PREFETCH}px 0px` });
    let t;
    new ResizeObserver(() => { clearTimeout(t); t = setTimeout(() => this.relayout(), 200); }).observe(this.scroller);
    let s, lastPage = 0;
    this.scroller.addEventListener("scroll", () => {
      const n = this.currentPage();
      if (n !== lastPage) { lastPage = n; this.onPage?.(n, this.pages.length); }
      clearTimeout(s);
      s = setTimeout(() => this.releaseFar(), 300);
    }, { passive: true });
    this.setupPinch();
  }

  async load(data) {
    this.destroy();
    this.task = pdfjsLib.getDocument({ data });
    this.doc = await this.task.promise;
    for (let n = 1; n <= this.doc.numPages; n++) {
      const page = await this.doc.getPage(n);
      const div = document.createElement("div");
      div.className = "page";
      div.dataset.page = n;
      const label = document.createElement("div");
      label.className = "page-label";
      label.textContent = `p.${n}`;
      div.append(label);
      this.root.append(div);
      this.pages.push({ n, page, div, vp1: page.getViewport({ scale: 1 }), state: "none", gen: 0 });
    }
    this.width = 0;
    this.relayout();
    this.pages.forEach((p) => this.observer.observe(p.div));
    this.onPage?.(1, this.pages.length);
  }

  destroy() {
    this.observer.disconnect();
    this.queue.clear();
    this.pages.forEach((p) => p.resolve?.());
    this.pages = [];
    this.textCache.clear();
    this.marked = [];
    this.root.querySelectorAll(".page").forEach((d) => d.remove());
    this.task?.destroy();
    this.task = null;
    this.doc = null;
  }

  get scale() { return this.width / this.pages[0].vp1.width; }

  dist(p) {
    const box = this.scroller.getBoundingClientRect();
    const r = p.div.getBoundingClientRect();
    if (r.bottom < box.top) return box.top - r.bottom;
    if (r.top > box.bottom) return r.top - box.bottom;
    return 0;
  }

  reset(p) {
    p.div.querySelector(".textLayer")?.remove();
    p.textLayer = null;
    p.state = "none";
    p.gen++;
    this.queue.delete(p);
    p.resolve?.();
    p.resolve = null;
  }

  relayout() {
    if (!this.pages.length) return;
    const w = Math.floor((this.scroller.clientWidth - 16) * this.zoom);
    if (w <= 0 || Math.abs(w - this.width) < 2) return;
    this.width = w;
    this.marked = [];
    for (const p of this.pages) {
      p.div.style.width = `${w}px`;
      p.div.style.height = `${Math.floor(p.vp1.height * this.scale)}px`;
      // 古い絵は引き伸ばしたまま残し，描き直しが終わったら差し替える（ちらつき防止）
      if (p.state !== "none") this.reset(p);
    }
    for (const p of this.pages) if (this.dist(p) < PREFETCH) this.render(p.n);
  }

  releaseFar() {
    if (this.gesture) return;
    for (const p of this.pages) {
      if (p.state === "done" && this.dist(p) > KEEP_MARGIN) {
        p.div.querySelectorAll("canvas").forEach((c) => { c.width = 0; c.height = 0; c.remove(); });
        this.reset(p);
      }
    }
  }

  // 描画を予約する．描き終わったら解決する Promise を返す
  render(n) {
    const p = this.pages[n - 1];
    if (!p) return Promise.resolve();
    if (p.state === "done") return Promise.resolve();
    if (p.state === "none") {
      p.state = "queued";
      p.promise = new Promise((res) => (p.resolve = res));
      this.queue.add(p);
      this.pump();
    }
    return p.promise;
  }

  async pump() {
    if (this.busy) return;
    this.busy = true;
    try {
      while (this.queue.size && !this.gesture) {
        let best = null, bd = Infinity;
        for (const p of this.queue) { const d = this.dist(p); if (d < bd) { bd = d; best = p; } }
        this.queue.delete(best);
        if (bd > KEEP_MARGIN) { best.state = "none"; best.resolve?.(); continue; }
        await this.draw(best);
      }
    } finally {
      this.busy = false;
    }
  }

  async draw(p) {
    p.state = "rendering";
    const gen = p.gen;
    const done = p.resolve;
    try {
      const scale = this.scale;
      const vp = p.page.getViewport({ scale });
      let dpr = Math.min(window.devicePixelRatio || 1, 2);
      const px = vp.width * vp.height * dpr * dpr;
      if (px > MAX_CANVAS_PIXELS) dpr *= Math.sqrt(MAX_CANVAS_PIXELS / px);
      const canvas = document.createElement("canvas");
      canvas.width = Math.floor(vp.width * dpr);
      canvas.height = Math.floor(vp.height * dpr);
      await p.page.render({ canvasContext: canvas.getContext("2d"), viewport: vp, transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : null }).promise;
      if (gen !== p.gen) { canvas.width = 0; return; } // 途中で拡大率が変わった
      p.div.querySelectorAll("canvas").forEach((c) => { c.width = 0; c.remove(); });
      p.div.prepend(canvas);
      p.div.style.setProperty("--scale-factor", scale);
      const tl = document.createElement("div");
      tl.className = "textLayer";
      p.div.append(tl);
      const textLayer = new pdfjsLib.TextLayer({ textContentSource: p.page.streamTextContent(), container: tl, viewport: vp });
      await textLayer.render();
      if (gen !== p.gen) { tl.remove(); return; }
      p.textLayer = textLayer;
      p.state = "done";
    } catch (e) {
      console.error(e);
      if (gen === p.gen) p.state = "none";
    } finally {
      done?.();
      if (p.resolve === done) p.resolve = null;
    }
  }

  // 基準点（画面上の座標）にあるページと，その中での相対位置
  anchorAt(x, y) {
    let best = this.pages[0], bd = Infinity;
    for (const p of this.pages) {
      const r = p.div.getBoundingClientRect();
      const d = y < r.top ? r.top - y : y > r.bottom ? y - r.bottom : 0;
      if (d < bd) { bd = d; best = p; }
      if (d === 0) break;
    }
    const r = best.div.getBoundingClientRect();
    return { p: best, rx: (x - r.left) / r.width, ry: (y - r.top) / r.height };
  }

  // 拡大率を変える．client = 画面上の基準点．拡大後も基準点の下に同じ箇所が来るようにスクロールを合わせる
  setZoom(z, client, anchor, pan = { x: 0, y: 0 }) {
    if (!this.pages.length) return this.zoom;
    const sc = this.scroller;
    const box = sc.getBoundingClientRect();
    const c = client || { x: box.left + sc.clientWidth / 2, y: box.top + sc.clientHeight / 3 };
    const a = anchor || this.anchorAt(c.x, c.y);
    this.zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));
    this.relayout();
    const r = a.p.div.getBoundingClientRect();
    sc.scrollLeft += r.left + a.rx * r.width - (c.x + pan.x);
    sc.scrollTop += r.top + a.ry * r.height - (c.y + pan.y);
    this.onZoom?.(this.zoom);
    return this.zoom;
  }

  // 2本指のピンチ（と，その間の移動）を PDF 部分だけに適用する
  setupPinch() {
    const sc = this.scroller;
    const dist = (t) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
    const mid = (t) => ({ x: (t[0].clientX + t[1].clientX) / 2, y: (t[0].clientY + t[1].clientY) / 2 });
    let raf = 0;
    const paint = () => {
      raf = 0;
      const g = this.gesture;
      if (g) this.root.style.transform = `translate(${g.pan.x}px, ${g.pan.y}px) scale(${g.s})`;
    };
    const end = () => {
      const g = this.gesture;
      if (!g) return;
      cancelAnimationFrame(raf);
      raf = 0;
      this.root.style.transform = "";
      this.root.style.transformOrigin = "";
      this.root.style.willChange = "";
      this.gesture = null;
      if (Math.abs(g.s - 1) > 0.01 || Math.hypot(g.pan.x, g.pan.y) > 2) this.setZoom(this.zoom * g.s, g.c, g.anchor, g.pan);
      this.pump();
    };
    sc.addEventListener("touchstart", (e) => {
      if (e.touches.length !== 2) return;
      e.preventDefault();
      const c = mid(e.touches);
      const rr = this.root.getBoundingClientRect();
      this.gesture = { d0: dist(e.touches), c, anchor: this.anchorAt(c.x, c.y), s: 1, pan: { x: 0, y: 0 } };
      this.root.style.willChange = "transform";
      this.root.style.transformOrigin = `${c.x - rr.left}px ${c.y - rr.top}px`;
    }, { passive: false });
    sc.addEventListener("touchmove", (e) => {
      const g = this.gesture;
      if (!g || e.touches.length !== 2) return;
      e.preventDefault();
      const m = mid(e.touches);
      const want = this.zoom * (dist(e.touches) / g.d0);
      g.s = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, want)) / this.zoom;
      g.pan = { x: m.x - g.c.x, y: m.y - g.c.y };
      if (!raf) raf = requestAnimationFrame(paint);
    }, { passive: false });
    sc.addEventListener("touchend", (e) => { if (e.touches.length < 2) end(); });
    sc.addEventListener("touchcancel", end);
    // Safari（iPhone の Chrome も同じエンジン）の画面全体ズームを止める
    for (const ev of ["gesturestart", "gesturechange", "gestureend"]) {
      document.addEventListener(ev, (e) => e.preventDefault(), { passive: false });
    }
    // PC：Ctrl(⌘)+ホイール／トラックパッドのピンチ
    sc.addEventListener("wheel", (e) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      this.setZoom(this.zoom * Math.exp(-e.deltaY * 0.01), { x: e.clientX, y: e.clientY });
    }, { passive: false });
  }

  currentPage() {
    if (!this.pages.length) return 0;
    const box = this.scroller.getBoundingClientRect();
    return this.anchorAt(box.left + box.width / 2, box.top + box.height / 3).p.n;
  }

  goToPage(n) {
    const p = this.pages[Math.min(this.pages.length, Math.max(1, n)) - 1];
    p?.div.scrollIntoView({ block: "start" });
  }

  // 読んでいた位置の保存と復元
  position() {
    if (!this.pages.length) return null;
    const box = this.scroller.getBoundingClientRect();
    const a = this.anchorAt(box.left + box.width / 2, box.top);
    return { page: a.p.n, ry: a.ry, zoom: this.zoom };
  }
  restore(pos) {
    if (!pos || !this.pages[pos.page - 1]) return;
    if (pos.zoom && pos.zoom !== this.zoom) { this.zoom = pos.zoom; this.relayout(); this.onZoom?.(this.zoom); }
    const p = this.pages[pos.page - 1];
    this.scroller.scrollTop += p.div.getBoundingClientRect().top - this.scroller.getBoundingClientRect().top + pos.ry * p.div.offsetHeight;
  }

  clearHighlight() {
    for (const { span, text } of this.marked) if (span.isConnected) span.textContent = text;
    this.marked = [];
    this.root.querySelectorAll(".hl").forEach((s) => s.classList.remove("hl"));
    this.root.querySelectorAll(".page.flash").forEach((s) => s.classList.remove("flash"));
  }

  // 引用箇所へ移動してハイライト．見つかれば true
  async jumpTo(n, quote) {
    const p = this.pages[n - 1];
    if (!p) return false;
    this.clearHighlight();
    p.div.scrollIntoView({ block: "start" });
    for (let i = 0; i < 5 && p.state !== "done"; i++) await this.render(n);
    if (!quote) return true;
    const items = p.textLayer?.textContentItemsStr;
    const hit = items ? locate(items, quote) : null;
    if (!hit) {
      p.div.classList.add("flash");
      return false;
    }
    const divs = p.textLayer.textDivs;
    let first = null;
    for (const { i, from, to } of hit.parts) {
      const span = divs[i];
      if (!span) continue;
      const text = span.textContent;
      if ((from === 0 && to >= text.length) || text !== items[i]) {
        span.classList.add("hl");
        first ??= span;
        continue;
      }
      // 行の一部だけを光らせる
      this.marked.push({ span, text });
      const mark = document.createElement("mark");
      mark.className = "hl";
      mark.textContent = text.slice(from, to);
      span.replaceChildren(text.slice(0, from), mark, text.slice(to));
      first ??= mark;
    }
    first?.scrollIntoView({ block: "center", inline: "center" });
    return true;
  }

  // 並べ替え用：引用がページ内のどのあたりにあるか（見つからなければ大きな値）
  async quoteOrder(n, quote) {
    const p = this.pages[n - 1];
    if (!p || !quote) return 1e9;
    if (!this.textCache.has(n)) {
      this.textCache.set(n, p.page.getTextContent().then((tc) => tc.items.map((it) => it.str ?? "")));
    }
    const hit = locate(await this.textCache.get(n), quote);
    return hit ? hit.start : 1e9;
  }

  // 各ページ右上に「質問 N」バッジ
  setBadges(counts) {
    for (const p of this.pages) {
      p.div.querySelector(".page-badge")?.remove();
      const c = counts.get(p.n);
      if (!c) continue;
      const b = document.createElement("button");
      b.className = "page-badge";
      b.textContent = `質問 ${c}`;
      b.onclick = () => this.onBadge?.(p.n);
      p.div.append(b);
    }
  }

  // 現在の選択範囲 → {page, quote}
  selection() {
    const sel = window.getSelection();
    const text = sel?.toString().replace(/\s+/g, " ").trim().replace(/^[.,;:)\]\s]+/, "");
    if (!text || !sel.anchorNode) return null;
    const el = sel.anchorNode.nodeType === 1 ? sel.anchorNode : sel.anchorNode.parentElement;
    const page = el?.closest?.(".page");
    if (!page || !this.root.contains(page)) return null;
    return { page: Number(page.dataset.page), quote: text };
  }
}
