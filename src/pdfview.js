// PDF をページごとに縦に並べて表示する．表示範囲の近くにあるページだけ描画し，離れたら解放する．
// ピンチ操作は PDF 部分だけを拡大縮小する（メニューなど画面全体は拡大しない）．
import * as pdfjsLib from "../vendor/pdfjs/pdf.min.mjs";
import { locate } from "./match.js";

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL("../vendor/pdfjs/pdf.worker.min.mjs", import.meta.url).href;

const MIN_ZOOM = 0.5;
const MAX_ZOOM = 4;
const MAX_CANVAS_PIXELS = 12_000_000; // iOS のキャンバス上限（約1677万画素）より余裕をもたせる
const KEEP_MARGIN = 1500; // この距離(px)より離れたページは描画を解放

export class PdfView {
  constructor(root, { onBadge, onZoom } = {}) {
    this.root = root; // ページを並べる要素
    this.scroller = root.parentElement; // スクロールする要素
    this.onBadge = onBadge;
    this.onZoom = onZoom;
    this.zoom = 1;
    this.width = 0;
    this.pages = []; // {n, page, div, vp1, state:'none'|'rendering'|'done', gen, textLayer, promise}
    this.observer = new IntersectionObserver((ents) => {
      for (const e of ents) if (e.isIntersecting) this.render(Number(e.target.dataset.page));
    }, { root: this.scroller, rootMargin: "800px 0px" });
    let t;
    new ResizeObserver(() => { clearTimeout(t); t = setTimeout(() => this.relayout(), 200); }).observe(this.scroller);
    let s;
    this.scroller.addEventListener("scroll", () => { clearTimeout(s); s = setTimeout(() => this.releaseFar(), 300); }, { passive: true });
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
  }

  destroy() {
    this.observer.disconnect();
    this.pages = [];
    this.root.querySelectorAll(".page").forEach((d) => d.remove());
    this.task?.destroy();
    this.task = null;
    this.doc = null;
  }

  get scale() { return this.width / this.pages[0].vp1.width; }

  near(margin) {
    const box = this.scroller.getBoundingClientRect();
    return (p) => {
      const r = p.div.getBoundingClientRect();
      return r.bottom > box.top - margin && r.top < box.bottom + margin;
    };
  }

  relayout() {
    if (!this.pages.length) return;
    const w = Math.floor((this.scroller.clientWidth - 16) * this.zoom);
    if (w <= 0 || Math.abs(w - this.width) < 2) return;
    this.width = w;
    for (const p of this.pages) {
      p.div.style.width = `${w}px`;
      p.div.style.height = `${Math.floor(p.vp1.height * this.scale)}px`;
      if (p.state !== "none") {
        // 古い絵は引き伸ばしたまま残し，描き直しが終わったら差し替える（ちらつき防止）
        p.div.querySelector(".textLayer")?.remove();
        p.textLayer = null;
        p.state = "none";
        p.gen++;
      }
    }
    const isNear = this.near(800);
    for (const p of this.pages) if (isNear(p)) this.render(p.n);
  }

  releaseFar() {
    const isNear = this.near(KEEP_MARGIN);
    for (const p of this.pages) {
      if (p.state === "done" && !isNear(p)) {
        p.div.querySelectorAll("canvas").forEach((c) => { c.width = 0; c.height = 0; c.remove(); });
        p.div.querySelector(".textLayer")?.remove();
        p.textLayer = null;
        p.state = "none";
        p.gen++;
      }
    }
  }

  render(n) {
    const p = this.pages[n - 1];
    if (!p) return undefined;
    if (p.state !== "none") return p.promise;
    p.state = "rendering";
    const gen = p.gen;
    p.promise = (async () => {
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
    })().catch((e) => { if (gen === p.gen) p.state = "none"; console.error(e); });
    return p.promise;
  }

  // 拡大率を変える．focus = スクロール領域内の基準点(px)．その点が動かないようにスクロールを合わせる
  setZoom(z, focus, pan = { x: 0, y: 0 }) {
    const sc = this.scroller;
    const f = focus || { x: sc.clientWidth / 2, y: sc.clientHeight / 3 };
    const old = this.zoom;
    const next = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));
    const cx = sc.scrollLeft + f.x;
    const cy = sc.scrollTop + f.y;
    this.zoom = next;
    this.relayout();
    const r = next / old;
    sc.scrollLeft = cx * r - (f.x + pan.x);
    sc.scrollTop = cy * r - (f.y + pan.y);
    this.onZoom?.(next);
    return next;
  }

  // 2本指のピンチ（と，その間の移動）を PDF 部分だけに適用する
  setupPinch() {
    const sc = this.scroller;
    let g = null;
    const dist = (t) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
    const mid = (t) => ({ x: (t[0].clientX + t[1].clientX) / 2, y: (t[0].clientY + t[1].clientY) / 2 });
    const end = () => {
      if (!g) return;
      const { s, focus, pan } = g;
      this.root.style.transform = "";
      this.root.style.transformOrigin = "";
      g = null;
      if (Math.abs(s - 1) > 0.02 || Math.hypot(pan.x, pan.y) > 2) this.setZoom(this.zoom * s, focus, pan);
    };
    sc.addEventListener("touchstart", (e) => {
      if (e.touches.length !== 2) return;
      e.preventDefault();
      const box = sc.getBoundingClientRect();
      const m = mid(e.touches);
      const focus = { x: m.x - box.left, y: m.y - box.top };
      g = { d0: dist(e.touches), mid0: m, focus, s: 1, pan: { x: 0, y: 0 } };
      this.root.style.transformOrigin = `${sc.scrollLeft + focus.x - this.root.offsetLeft}px ${sc.scrollTop + focus.y - this.root.offsetTop}px`;
    }, { passive: false });
    sc.addEventListener("touchmove", (e) => {
      if (!g || e.touches.length !== 2) return;
      e.preventDefault();
      const m = mid(e.touches);
      const want = this.zoom * (dist(e.touches) / g.d0);
      g.s = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, want)) / this.zoom;
      g.pan = { x: m.x - g.mid0.x, y: m.y - g.mid0.y };
      this.root.style.transform = `translate(${g.pan.x}px, ${g.pan.y}px) scale(${g.s})`;
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
      const box = sc.getBoundingClientRect();
      this.setZoom(this.zoom * Math.exp(-e.deltaY * 0.01), { x: e.clientX - box.left, y: e.clientY - box.top });
    }, { passive: false });
  }

  clearHighlight() {
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
    const idx = p.textLayer ? locate(p.textLayer.textContentItemsStr, quote) : null;
    if (!idx) {
      p.div.classList.add("flash");
      return false;
    }
    const divs = p.textLayer.textDivs;
    idx.forEach((i) => divs[i]?.classList.add("hl"));
    divs[idx[0]]?.scrollIntoView({ block: "center", inline: "center" });
    return true;
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
