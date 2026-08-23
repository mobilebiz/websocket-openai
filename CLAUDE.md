# CLAUDE.md

Vonage Voice API の音声ストリームを OpenAI Realtime API に中継する Fastify サーバー。

## コマンド

```sh
npm start        # サーバー起動
npm run debug    # Vonage の Webhook URL を .env に合わせて更新してから起動
npm test         # tap によるユニットテスト
npm run deploy   # Webhook URL を .env.production に合わせて更新して Fly.io へデプロイ
```

## アーキテクチャ

同じコードベースを `APP_ROLE` で 2 つの役割に切り替えて動かす。

- `full` (既定 / Fly.io) — NCCO の返却 + 音声の WebSocket 中継 + `/connect`
- `front` (VCR) — **NCCO を返すだけ**。`/media-stream` と `/connect` は登録しない

前段が必要な理由は、Vonage の `answer_url` が 5 秒しか待たないため
(`socket_timeout` は上限 5,000ms で延長不可)。Fly.io のコールドスタート (約 8 秒) が
間に合わず通話が切れる。常時起動の VCR に受けさせ、WebSocket だけ Fly.io に向ける。

`front` は NCCO を返す前に本体へ投げっぱなしのリクエストを打つ。**この応答を待ってはいけない**
(5 秒制限を自分で食い潰すため)。NCCO の `talk` の読み上げ時間が本体の起動時間になる。

`index.js` は設定の読み込みと起動のみ。実体は `src/` にある。

- `src/config.js` — 環境変数を読んで 1 つの設定オブジェクトにする。`process.env` を直接読むのは
  ここと `index.js` だけ。他のモジュールは引数で config を受け取る（テストで差し替えられるように）。
  待ち受けポートは `VCR_PORT` を最優先する（VCR がこれで指定してくる）
- `src/server.js` — `buildServer(config)` が Fastify インスタンスを返す。`listen` はしないので
  テストからは `fastify.inject()` でそのまま使える
- `src/realtime/bridge.js` — 中継の本体。**状態はすべて `createBridge` のスコープに閉じること**。
  モジュールスコープに可変状態を置くと同時通話が互いに干渉する（過去にこのバグがあった）
- `src/tools/` — ツールを追加するときは、`definition` と `handler` を export するモジュールを作り
  `src/tools/index.js` の `MODULES` に足す。ディスパッチの分岐を書き足す必要はない

## 気をつけること

### サンプリングレート

Vonage は 16kHz、OpenAI Realtime API は 24kHz 固定。`src/audio/resample.js` で双方向に変換する。
どちらかを省略すると音声が 1.5 倍速／遅くなり、認識精度が落ちる。

音声は 20ms フレーム（16kHz なら 640 バイト、24kHz なら 960 バイト）単位で扱う。
可変長で届くデータは `FrameSplitter` を通して端数を持ち越すこと。切り捨てると音が途切れる。

### Realtime API のスキーマ

2025-08-28 の GA スキーマを使っている。ベータ期の書き方（`OpenAI-Beta: realtime=v1` ヘッダー、
`modalities`、`input_audio_format`、トップレベル `voice`、`temperature`、
`response.audio.delta`）は使わない。イベント名は `response.output_audio.delta` のように
`output_` が付く。

### ログ

`console.log` ではなく Fastify のロガー（pino）を使う。開発時は pino-pretty で整形される。
JWT や API キーをログに出さないこと。

## デプロイ

本体は Fly.io（`fly.toml`）。`main` への push で GitHub Actions が動く。
本番の秘密鍵はファイルではなく `VONAGE_PRIVATE_KEY` の環境変数で渡す。

前段は VCR（`vcr.yml`）。`vcr deploy` で反映する。`vcr` CLI が別アカウントで認証されている
ことがあるので、その場合は `--api-key` / `--api-secret` を渡す。

Webhook URL は `scripts/change-url.js` が設定する。`ANSWER_URL_HOST` を指定すると
`answer_url` だけ前段を向く。**手でダッシュボードから設定しても `npm run deploy` で
上書きされる**ので、変更はこのスクリプト経由で行うこと。

## 関連ドキュメント

このプロジェクトの解説記事が別リポジトリにある。実装を変えたら追随が必要。

`~/Documents/workspace/zennBook/vonage-how-to/articles/websocket-openai.md`
