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

`index.js` は設定の読み込みと起動のみ。実体は `src/` にある。

- `src/config.js` — 環境変数を読んで 1 つの設定オブジェクトにする。`process.env` を直接読むのは
  ここと `index.js` だけ。他のモジュールは引数で config を受け取る（テストで差し替えられるように）
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

Fly.io（`fly.toml`）。`main` への push で GitHub Actions が動く。
本番の秘密鍵はファイルではなく `VONAGE_PRIVATE_KEY` の環境変数で渡す。

## 関連ドキュメント

このプロジェクトの解説記事が別リポジトリにある。実装を変えたら追随が必要。

`~/Documents/workspace/zennBook/vonage-how-to/articles/websocket-openai.md`
