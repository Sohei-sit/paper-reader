// データの読み書き先．GitHub（Contents API）とローカル開発サーバ（dev_server.py）の2種類．
// どちらも list / readText / readBinary / writeText を持つ．

const utf8 = new TextDecoder();
const b64ToBytes = (b64) => Uint8Array.from(atob(b64.replace(/\n/g, "")), (c) => c.charCodeAt(0));
const textToB64 = (text) => {
  const bytes = new TextEncoder().encode(text);
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
};

export class ConflictError extends Error {}

export class GitHubSource {
  constructor({ repo, branch, token }) {
    this.repo = repo;
    this.branch = branch || "main";
    this.token = token;
  }
  url(path) {
    const p = path.split("/").map(encodeURIComponent).join("/");
    return `https://api.github.com/repos/${this.repo}/contents/${p}?ref=${encodeURIComponent(this.branch)}`;
  }
  async req(path, { accept = "application/vnd.github+json", method = "GET", body } = {}) {
    const res = await fetch(method === "GET" ? this.url(path) : this.url(path).split("?")[0], {
      method,
      cache: "no-store",
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: accept,
        "X-GitHub-Api-Version": "2022-11-28",
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 409 || res.status === 422) throw new ConflictError(`conflict on ${path}`);
    if (!res.ok) {
      const msg = res.status === 401 ? "token が無効です（期限切れ？）"
        : res.status === 404 ? `見つかりません: ${path}（リポジトリ名・権限・ブランチを確認）`
        : `GitHub API ${res.status}`;
      throw new Error(msg);
    }
    return res;
  }
  // 接続診断：どこで失敗しているかを具体的に返す
  async diagnose() {
    const h = { Authorization: `Bearer ${this.token}`, Accept: "application/vnd.github+json" };
    const r1 = await fetch(`https://api.github.com/repos/${this.repo}`, { headers: h, cache: "no-store" });
    if (r1.status === 401) return "token が無効です（コピーミスか，削除・期限切れ）";
    if (r1.status === 404) return `token から ${this.repo} が見えません．token の Repository access で「Only select repositories」→ ${this.repo.split("/")[1]} を選んでいるか，リポジトリ名が正しいか確認してください`;
    if (!r1.ok) return `リポジトリ情報の取得に失敗（${r1.status}）`;
    const r2 = await fetch(this.url("papers"), { headers: h, cache: "no-store" });
    if (r2.status === 403 || r2.status === 404) {
      const r3 = await fetch(this.url(""), { headers: h, cache: "no-store" });
      if (!r3.ok) return "リポジトリは見えますが中身を読めません．token の Permissions に Contents（Read and write）を追加してください";
      return `ブランチ ${this.branch} に papers/ がありません`;
    }
    if (!r2.ok) return `papers/ の取得に失敗（${r2.status}）`;
    return null;
  }
  async list(path, { allowMissing = false } = {}) {
    const res = await this.req(path).catch((e) => {
      if (allowMissing && String(e.message).startsWith("見つかりません")) return null;
      throw e;
    });
    if (!res) return [];
    const arr = await res.json();
    return arr.map((x) => ({ name: x.name, type: x.type === "dir" ? "dir" : "file", sha: x.sha }));
  }
  async readText(path) {
    const j = await (await this.req(path)).json();
    if (j.content) return { text: utf8.decode(b64ToBytes(j.content)), sha: j.sha };
    const raw = await (await this.req(path, { accept: "application/vnd.github.raw" })).text();
    return { text: raw, sha: j.sha };
  }
  async readBinary(path) {
    return (await this.req(path, { accept: "application/vnd.github.raw" })).arrayBuffer();
  }
  async writeText(path, text, sha, message) {
    const body = { message, content: textToB64(text), branch: this.branch };
    if (sha) body.sha = sha;
    const j = await (await this.req(path, { method: "PUT", body })).json();
    return { sha: j.content.sha };
  }
}

export class LocalSource {
  async req(url, opts) {
    const res = await fetch(url, { cache: "no-store", ...opts });
    if (res.status === 409) throw new ConflictError("conflict");
    if (!res.ok) throw new Error(`local ${res.status}: ${url}`);
    return res;
  }
  q(path) { return encodeURIComponent(path); }
  async diagnose() { return null; }
  async list(path) { return (await this.req(`api/list?path=${this.q(path)}`)).json(); }
  async readText(path) {
    const res = await this.req(`api/file?path=${this.q(path)}`);
    return { text: await res.text(), sha: res.headers.get("X-Sha") };
  }
  async readBinary(path) { return (await this.req(`api/file?path=${this.q(path)}`)).arrayBuffer(); }
  async writeText(path, text, sha, message) {
    const res = await this.req(`api/file?path=${this.q(path)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: text, sha, message }),
    });
    return res.json();
  }
}
