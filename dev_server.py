#!/usr/bin/env python3
"""PC で使うためのローカルサーバ．ビューアを配信し，データ用リポジトリのファイルを読み書きする．

使い方:
  python3 dev_server.py --data ../paper-reader-data [--port 8000]
ブラウザで http://localhost:8000 を開き，設定で「ローカル」を選ぶ．
書き込みはファイルを更新するだけ（commit / push は自分で行う）．
"""
import argparse
import hashlib
import json
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

VIEWER = Path(__file__).resolve().parent


class Handler(SimpleHTTPRequestHandler):
    data_root: Path = None
    extensions_map = {**SimpleHTTPRequestHandler.extensions_map, ".mjs": "text/javascript", ".js": "text/javascript"}

    def resolve(self):
        qs = parse_qs(urlparse(self.path).query)
        rel = qs.get("path", [""])[0]
        p = (self.data_root / rel).resolve()
        if p != self.data_root and self.data_root not in p.parents:
            raise PermissionError(rel)
        return p

    def send_json(self, obj, status=200):
        body = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        route = urlparse(self.path).path
        if route not in ("/api/list", "/api/file"):
            return super().do_GET()
        try:
            p = self.resolve()
        except PermissionError:
            return self.send_json({"error": "forbidden"}, 403)
        if route == "/api/list":
            if not p.is_dir():
                return self.send_json([])
            items = [{"name": c.name, "type": "dir" if c.is_dir() else "file"}
                     for c in sorted(p.iterdir()) if not c.name.startswith(".")]
            return self.send_json(items)
        if not p.is_file():
            return self.send_json({"error": "not found"}, 404)
        data = p.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", "application/pdf" if p.suffix == ".pdf" else "text/plain; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("X-Sha", hashlib.sha1(data).hexdigest())
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def do_PUT(self):
        if urlparse(self.path).path != "/api/file":
            return self.send_json({"error": "not found"}, 404)
        try:
            p = self.resolve()
        except PermissionError:
            return self.send_json({"error": "forbidden"}, 403)
        req = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))))
        if p.exists():
            cur = hashlib.sha1(p.read_bytes()).hexdigest()
            if req.get("sha") != cur:
                return self.send_json({"error": "conflict"}, 409)
        elif req.get("sha"):
            return self.send_json({"error": "conflict"}, 409)
        p.parent.mkdir(parents=True, exist_ok=True)
        data = req["content"].encode("utf-8")
        p.write_bytes(data)
        self.send_json({"sha": hashlib.sha1(data).hexdigest()})


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", default="../paper-reader-data")
    ap.add_argument("--port", type=int, default=8000)
    args = ap.parse_args()
    Handler.data_root = Path(args.data).resolve()
    print(f"viewer: {VIEWER}\ndata:   {Handler.data_root}\nhttp://localhost:{args.port}")
    ThreadingHTTPServer(("127.0.0.1", args.port), partial(Handler, directory=str(VIEWER))).serve_forever()


if __name__ == "__main__":
    main()
