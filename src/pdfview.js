// PDF をページごとに縦に並べて表示する．表示範囲に入ったページだけ描画する．
import * as pdfjsLib from "../vendor/pdfjs/pdf.min.mjs";
import { locate } from "./match.js";

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL("../vendor/pdfjs/pdf.worker.min.mjs", import.meta.url).href;

export class PdfView {
  constructor(root, { onBadge } = {}) {
    this.root = root;
    this.onBadge = onBadge;
    this.zoom = 1;
    this.pages = []; // {n, div, vp1, state:'none'|'rendering'|'done', textLayer, promise}
    this.observer = new IntersectionObserver((ents) => {
      for (const e of ents) if (e.isIntersecting) this.render(Number(e.target.dataset.page));
    }, { root, rootMargin: "1200px 0px" });
    let t;
    new ResizeObserver(() => { clearTimeout(t); t = setTimeout(() => this.relayout(), 250); }).observe(root);
  }

  async load(data) {
    this.destroy();
    this.doc = await pdfjsLib.getDocument({ data }).promise;
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
      this.pages.push({ n, page, div, vp1: page.getViewport({ scale: 1 }), state: "none" });
    }
    this.width = 0;
    this.relayout();
    this.pages.forEach((p) => this.observer.observe(p.div));
  }

  destroy() {
    this.observer.disconnect();
    this.pages = [];
    this.root.querySelectorAll(".page").forEach((d) => d.remove());
    this.doc?.destroy();
    this.doc = null;
  }

  get scale() { return this.width / this.pages[0].vp1.width; }

  relayout() {
    if (!this.pages.length) return;
    const w = Math.floor((this.root.clientWidth - 16) * this.zoom);
    if (w <= 0 || Math.abs(w - this.width) < 2) return;
    this.width = w;
    for (const p of this.pages) {
      p.div.style.width = `${w}px`;
      p.div.style.height = `${Math.floor(p.vp1.height * this.scale)}px`;
      if (p.state !== "none") { p.state = "none"; p.div.querySelectorAll("canvas,.textLayer").forEach((x) => x.remove()); }
    }
    // 見えているページを描き直す
    const box = this.root.getBoundingClientRect();
    for (const p of this.pages) {
      const r = p.div.getBoundingClientRect();
      if (r.bottom > box.top - 1200 && r.top < box.bottom + 1200) this.render(p.n);
    }
  }

  render(n) {
    const p = this.pages[n - 1];
    if (!p || p.state !== "none") return p?.promise;
    p.state = "rendering";
    p.promise = (async () => {
      const scale = this.scale;
      const vp = p.page.getViewport({ scale });
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const canvas = document.createElement("canvas");
      canvas.width = Math.floor(vp.width * dpr);
      canvas.height = Math.floor(vp.height * dpr);
      canvas.style.width = `${Math.floor(vp.width)}px`;
      canvas.style.height = `${Math.floor(vp.height)}px`;
      p.div.style.setProperty("--scale-factor", scale);
      const ctx = canvas.getContext("2d");
      await p.page.render({ canvasContext: ctx, viewport: vp, transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : null }).promise;
      p.div.prepend(canvas);
      const tl = document.createElement("div");
      tl.className = "textLayer";
      p.div.append(tl);
      p.textLayer = new pdfjsLib.TextLayer({ textContentSource: p.page.streamTextContent(), container: tl, viewport: vp });
      await p.textLayer.render();
      p.state = "done";
    })().catch((e) => { p.state = "none"; console.error(e); });
    return p.promise;
  }

  // 拡大縮小．表示中のページ位置を保つ
  setZoom(z) {
    const pane = this.root.parentElement;
    const ratio = pane.scrollTop / Math.max(1, pane.scrollHeight);
    this.zoom = Math.min(3, Math.max(1, z));
    this.relayout();
    pane.scrollTop = ratio * pane.scrollHeight;
    return this.zoom;
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
    await this.render(n);
    if (!quote) return true;
    const idx = p.textLayer ? locate(p.textLayer.textContentItemsStr, quote) : null;
    if (!idx) {
      p.div.classList.add("flash");
      return false;
    }
    const divs = p.textLayer.textDivs;
    idx.forEach((i) => divs[i]?.classList.add("hl"));
    divs[idx[0]]?.scrollIntoView({ block: "center" });
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

  currentPage() {
    const box = this.root.getBoundingClientRect();
    const mid = box.top + box.height / 3;
    for (const p of this.pages) {
      const r = p.div.getBoundingClientRect();
      if (r.bottom > mid) return p.n;
    }
    return 1;
  }
}
