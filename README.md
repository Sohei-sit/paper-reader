# paper-reader

論文PDFを読みながら，疑問をスレッドにして根拠つきで深めるためのビューア．
データ（PDF・スレッド）は別の非公開リポジトリ `paper-reader-data` に置き，ブラウザから GitHub API で読み書きする．
このリポジトリにはコードだけを置く（論文やメモは含めない）．

## 使い方

- **スマホ／PC（GitHub）**：GitHub Pages の URL を開き，⚙ で token を設定する．
  - token は fine-grained で，Repository access を `paper-reader-data` のみ，Permissions の Contents を Read and write にする．
  - token はその端末のブラウザ（localStorage）にだけ保存される．
- **PC（ローカル）**：`python3 dev_server.py --data ../paper-reader-data` で起動し，http://localhost:8000 を開く．
  書き込みはファイルを更新するだけなので，commit / push は自分で行う．

## 機能

- PDF 表示（ピンチ／Ctrl+ホイール／ボタンで拡大縮小．拡大するのは PDF 部分だけ．ページごとの質問数バッジ）
- メニューバーの位置（下／上）を ⚙ で切り替え（端末ごとに保存）
- 文章を選択して「選択箇所で質問」
- スレッド一覧（派生ツリー／論文の順／最近の更新／新しい順／古い順で並べ替え，未回答／回答済みの絞り込み，検索，最新メッセージのプレビュー）
- 回答中の引用 `[[p.N | 原文]]` をタップすると該当箇所へ移動して文単位でハイライト（スマホでは「← スレッドへ」で戻れる）
- 現在ページの表示とページ指定ジャンプ，論文ごとに読んでいた位置と倍率を保存
- 書きかけの質問を保存（投稿すると消える）
- `[事実]` `[推論]` `[不明]` タグの色分け
- 追加の質問，派生スレッドの作成
- 「Claude に回答を頼む」で依頼文をコピー（回答は Claude Code が paper-reader-data を編集して書く）
- アプリに戻ると自動で再読込

## 構成

```
index.html, style.css
src/app.js       画面と操作
src/pdfview.js   PDF 描画・ハイライト（pdf.js）
src/match.js     引用文の照合（paper-reader-data/scripts/common.py と同じ正規化）
src/thread.js    スレッドファイルの読み書き
src/source.js    GitHub API／ローカルサーバ
vendor/          pdf.js 6.5.438, marked 18.3.0（ライセンス同梱）
dev_server.py    ローカル用サーバ
```
