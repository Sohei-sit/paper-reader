// 引用文をPDFのテキストレイヤー上で探す．
// 正規化規則は paper-reader-data/scripts/common.py の normalize() と同じにすること．

export function normalize(s) {
  return s.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
}

// items: テキストレイヤーの各spanの文字列（textContentItemsStr）
// 戻り値: { start, parts: [{i, from, to}] }．i は span の index，from/to はその span 内の文字位置（UTF-16）
//         見つからなければ null．start は正規化後の文字列での位置（ページ内の順序付けに使う）
export function locate(items, quote) {
  const q = normalize(quote);
  if (!q) return null;
  let norm = "";
  const map = []; // 正規化後の1文字 → [span index, 元の文字の開始位置, 終了位置]
  items.forEach((str, i) => {
    let pos = 0;
    for (const ch of str) {
      const n = normalize(ch);
      for (const c of n) { norm += c; map.push([i, pos, pos + ch.length]); }
      pos += ch.length;
    }
  });
  const hit = (needle) => {
    const at = norm.indexOf(needle);
    return at < 0 ? null : [at, at + needle.length];
  };
  // 完全一致 → だめなら先頭と末尾の断片で範囲を推定
  let range = hit(q);
  if (!range && q.length > 40) {
    const head = hit(q.slice(0, 30));
    const tail = hit(q.slice(-30));
    if (head && tail && tail[1] > head[0]) range = [head[0], tail[1]];
    else if (head) range = [head[0], Math.min(norm.length, head[0] + q.length)];
  }
  if (!range) return null;
  const parts = new Map();
  for (let k = range[0]; k < range[1]; k++) {
    const [i, a, b] = map[k];
    const cur = parts.get(i);
    if (!cur) parts.set(i, { i, from: a, to: b });
    else { cur.from = Math.min(cur.from, a); cur.to = Math.max(cur.to, b); }
  }
  return { start: range[0], parts: [...parts.values()] };
}
