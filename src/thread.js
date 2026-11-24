// スレッドファイル（フラットなフロントマター + ## Q / ## A セクション）の読み書き．
// 形式の定義は paper-reader-data/CLAUDE.md を参照．

const ORDER = ["id", "title", "status", "parent", "created", "anchor_page", "anchor_quote"];

export function parseThread(raw) {
  const meta = {};
  let body = raw;
  if (raw.startsWith("---\n")) {
    const end = raw.indexOf("\n---", 4);
    if (end !== -1) {
      for (const line of raw.slice(4, end).split("\n")) {
        const i = line.indexOf(":");
        if (i < 0) continue;
        const k = line.slice(0, i).trim();
        let v = line.slice(i + 1).trim();
        if (v.startsWith('"')) { try { v = JSON.parse(v); } catch { /* そのまま */ } }
        meta[k] = v;
      }
      body = raw.slice(end + 4).replace(/^\n+/, "");
    }
  }
  const sections = [];
  const re = /^## (Q|A)\b[ \t]*(.*)$/gm;
  let m, last = null;
  while ((m = re.exec(body))) {
    if (last) last.body = body.slice(last.start, m.index).trim();
    last = { kind: m[1], stamp: m[2].trim(), start: re.lastIndex };
    sections.push(last);
  }
  if (last) last.body = body.slice(last.start).trim();
  sections.forEach((s) => delete s.start);
  const lastKind = sections.length ? sections[sections.length - 1].kind : "Q";
  const open = meta.status === "open" || lastKind === "Q";
  return { meta, sections, open };
}

function fmt(k, v) {
  if (v === undefined || v === null || v === "") return `${k}: ""`;
  if (k === "status") return `${k}: ${v}`;
  if (k === "anchor_page") return `${k}: ${Number(v)}`;
  return `${k}: ${JSON.stringify(String(v))}`;
}

export function newThreadText(meta, question, stamp) {
  const keys = ORDER.filter((k) => k in meta);
  const head = keys.map((k) => fmt(k, meta[k])).join("\n");
  return `---\n${head}\n---\n\n## Q ${stamp}\n${question.trim()}\n`;
}

// 既存ファイルに質問を追記し，status を open に戻す（Claude の編集を崩さないよう最小変更）
export function appendQuestion(raw, question, stamp) {
  let text = raw.replace(/^(---\n[\s\S]*?^status:)[^\n]*$/m, "$1 open");
  return `${text.trimEnd()}\n\n## Q ${stamp}\n${question.trim()}\n`;
}

export function nowStamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}
