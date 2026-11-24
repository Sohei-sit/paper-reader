// 引用文をPDFのテキストレイヤー上で探す．
// 正規化規則は paper-reader-data/scripts/common.py の normalize() と同じにすること．

export function normalize(s) {
  return s.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
}

// items: テキストレイヤーの各spanの文字列（textContentItemsStr）
// 戻り値: 一致した span の index 配列（見つからなければ null）
export function locate(items, quote) {
  const q = normalize(quote);
  if (!q) return null;
  let norm = "";
  const map = [];
  items.forEach((str, i) => {
    for (const ch of str) {
      const n = normalize(ch);
      for (const c of n) { norm += c; map.push(i); }
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
  const set = new Set();
  for (let k = range[0]; k < range[1]; k++) set.add(map[k]);
  return [...set];
}
