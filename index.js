import Fastify from 'fastify';
import WebSocket from 'ws';
import dotenv from 'dotenv';
import fastifyFormBody from '@fastify/formbody';
import fastifyWs from '@fastify/websocket';
import fs from 'fs';
import path from 'path';
import fetch from 'node-fetch';
import jwt from 'jsonwebtoken';
import { randomUUID } from 'crypto';
import { pcm24To16 } from './lib/audio-converter.js';
import { getWeatherInfo } from './get_weather.js';

// Vonage Voice による音声を受け取り、OpenAI Realtime API へ転送する役割を担うサーバー

dotenv.config();

// 環境変数を読み込み、必要な値を取り出す
const {
  OPENAI_MODEL,
  SERVER_URL,
  VONAGE_APPLICATION_ID,
  VONAGE_PRIVATE_KEY_PATH,
  VONAGE_OUTBOUND_FROM,
  VONAGE_PRIVATE_KEY
} = process.env;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY_SECRET || process.env.OPENAI_API_KEY;

// 必須情報がそろっていなければ起動を止める
if (!OPENAI_MODEL || !SERVER_URL || !OPENAI_API_KEY) {
  console.error('環境変数が不足しています。 .envファイル、もしくはvcr.ymlで設定してください。');
  process.exit(1);
}

// Fastify サーバーを初期化し、必要なプラグインを登録
const fastify = Fastify();
fastify.register(fastifyFormBody);
fastify.register(fastifyWs);

console.debug(`VCR_PORT: ${process.env.VCR_PORT}`);
const PORT = process.env.VCR_PORT || process.env.PORT || 3000;

// OpenAI Realtime からのイベントのうちログを残したい種類を列挙
const LOG_EVENT_TYPES = [
  'response.content.done',
  // 'rate_limits.updated',
  'response.created',
  'response.done',
  'response.audio_transcript.done',
  // 'response.function_call_arguments.delta',
  'response.function_call_arguments.done',
  'input_audio_buffer.committed',
  'input_audio_buffer.speech_stopped',
  'input_audio_buffer.speech_started',
  'session.created',
  'session.updated',
  'session.deleted',
  // 'conversation.created',
  'conversation.item.created',
  'conversation.item.truncated',
  'conversation.item.input_audio_transcription.completed',
  'error'
];

let wsOpenAiOpened = false;
let isProcessingAudio = true;

// system-message.txt を優先し、ファイルがない場合はデフォルト文字列を使用
const SYSTEM_MESSAGE_FILE = new URL('./system-message.txt', import.meta.url);
const DEFAULT_SYSTEM_MESSAGE = 'あなたの名前はチャッピーです。明るくフレンドリーなAIアシスタントです。ユーザーが興味を持っている話題について会話し、適切な情報を提供します。ジョークや楽しい話題を交えながら、常にポジティブでいてください。なお、会話はすべて日本語で行いますが、ユーザーが言語を指定した場合は、その言語で回答をしてください。また、会話の最初は「こんにちは。チャッピーです。今日はどのようなお話をしましょうか？」と挨拶をしてください。';
const loadSystemMessage = () => {
  try {
    const content = fs.readFileSync(SYSTEM_MESSAGE_FILE, 'utf8').trim();
    if (content) return content;
    console.warn('system-message.txt が空です。デフォルトメッセージを使用します。');
  } catch (error) {
    console.warn('system-message.txt を読み込めませんでした。デフォルトメッセージを使用します。', error?.message);
  }
  return DEFAULT_SYSTEM_MESSAGE;
};
const SYSTEM_MESSAGE = loadSystemMessage();

const buildPublicUrl = (pathname = '') => {
  if (!SERVER_URL) return '';
  const hasProtocol = SERVER_URL.startsWith('http://') || SERVER_URL.startsWith('https://');
  const baseUrl = hasProtocol ? SERVER_URL : `https://${SERVER_URL}`;
  return `${baseUrl}${pathname}`;
};

const resolveVonagePrivateKey = () => {
  if (VONAGE_PRIVATE_KEY && VONAGE_PRIVATE_KEY.trim()) {
    return VONAGE_PRIVATE_KEY.trim();
  }

  if (!VONAGE_PRIVATE_KEY_PATH) {
    return null;
  }

  const resolvedPath = path.isAbsolute(VONAGE_PRIVATE_KEY_PATH)
    ? VONAGE_PRIVATE_KEY_PATH
    : path.resolve(process.cwd(), VONAGE_PRIVATE_KEY_PATH);
  try {
    return fs.readFileSync(resolvedPath, 'utf8').trim();
  } catch (error) {
    console.warn(`Vonageのプライベートキーを ${resolvedPath} から読み込めませんでした: ${error.message}`);
    return null;
  }
};

const vonagePrivateKey = resolveVonagePrivateKey();

const createVonageJwt = () => {
  if (!VONAGE_APPLICATION_ID || !vonagePrivateKey) {
    throw new Error('VonageのアプリケーションIDまたはプライベートキーが設定されていません。');
  }
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    application_id: VONAGE_APPLICATION_ID,
    iat: now,
    exp: now + 60 * 5,
    jti: randomUUID()
  };

  return jwt.sign(payload, vonagePrivateKey, { algorithm: 'RS256' });
};
// const SYSTEM_MESSAGE = 'あなたは明るくフレンドリーなAIアシスタントです。ユーザーが興味を持っている話題について会話し、適切な情報を提供します。ジョークや楽しい話題を交えながら、常にポジティブでいてください。なお、会話はすべて日本語で行いますが、ユーザーが言語を指定した場合は、その言語で回答をしてください。また、会話の最初は「こんにちは。今日はどのようなお話をしましょうか？」と挨拶をしてください。';
// const SYSTEM_MESSAGE = 'You are a bright and friendly AI assistant. You converse about topics of interest to the user and provide relevant information. Stay positive at all times with jokes and fun topics.';

// ルート: サービスが稼働していることを確認するための最小限のヘルスチェック
fastify.get('/', async (request, reply) => {
  reply.send({ message: 'Vonage Voiceサーバーが稼働中です。' });
});

// 固有のヘルスチェック (外部監視サービスなどで利用)
fastify.get('/_/health', async (request, reply) => {
  reply.send('OK');
});

// Prometheus やメトリクス収集用に用意されたエンドポイント
fastify.get('/_/metrics', async (request, reply) => {
  reply.send('OK');
});

// Vonage のイベント Webhook を受け取ってログ出力のみを行う
fastify.all('/event', async (request, reply) => {
  console.log(JSON.stringify(request.body, null, 2));
  reply.send('OK');
});

// 指定した番号に Vonage Voice API v2 でアウトバウンド発信する
fastify.post('/connect', async (request, reply) => {
  const { to, from } = request.body ?? {};
  if (!to) {
    return reply.status(400).send({ error: '`to` は必須です。E.164形式で指定してください。' });
  }

  const outboundFrom = from || VONAGE_OUTBOUND_FROM;
  if (!outboundFrom) {
    return reply.status(400).send({ error: '`from` を指定するか VONAGE_OUTBOUND_FROM を環境変数で設定してください。' });
  }

  let jwtToken;
  try {
    jwtToken = createVonageJwt();
    console.log('Vonage JWT を生成しました', jwtToken);
  } catch (error) {
    console.error('Vonage JWT の生成に失敗しました', error);
    return reply.status(500).send({ error: 'Vonage JWT の生成に失敗しました。' });
  }

  const payload = {
    to: [{ type: 'phone', number: to }],
    from: { type: 'phone', number: outboundFrom },
    answer_url: [buildPublicUrl('/answer')],
    answer_method: 'POST',
    event_url: [buildPublicUrl('/event')],
    event_method: 'POST'
  };

  try {
    const response = await fetch('https://api.nexmo.com/v2/calls', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${jwtToken}`
      },
      body: JSON.stringify(payload)
    });

    const responseBody = await response.json().catch(() => ({}));

    if (!response.ok) {
      console.error('Vonage Voice API の呼び出しに失敗しました', responseBody);
      return reply.status(response.status).send({
        error: 'Vonage Voice API の呼び出しに失敗しました。',
        details: responseBody
      });
    }

    return reply.status(201).send(responseBody);
  } catch (error) {
    console.error('Vonage Voice API との通信に失敗しました', error);
    return reply.status(502).send({ error: 'Vonage Voice API との通信に失敗しました。' });
  }
});

// 着信コールへの応答を生成し、Vonage の WebSocket ストリームに接続させる
fastify.all('/answer', async (request, reply) => {
  console.log(`🐞 /answer called. ${SERVER_URL}`);
  // Vonage に返す NCCO: 簡単な挨拶のあと WebSocket へ接続
  const nccoResponse = [
    {
      action: 'talk',
      text: '担当者にお繋ぎいたしますので、このまま少々お待ちください。',
      language: 'ja-JP'
    },
    {
      action: 'connect',
      endpoint: [
        {
          type: 'websocket',
          uri: `wss://${SERVER_URL}/media-stream`,
          contentType: 'audio/l16;rate=16000',
        }
      ]
    }
  ];

  reply.type('application/json').send(nccoResponse);
});

// WebSocket ルート: Vonage のメディアストリームと OpenAI Realtime をつなぐ
fastify.register(async (fastify) => {
  fastify.get('/media-stream', { websocket: true }, (connection, req) => {
    console.log('クライアントが接続されました');

    // 会話の状態やタイミングを記録する変数
    // let responseId = null;
    let conversationItemId = null;
    let responseStartTimestamp = null;  // 応答開始時のタイムスタンプ
    let latestAudioTimestamp = 0;       // 最新の音声タイムスタンプ

    // OpenAI Realtime API の WebSocket に接続
    const openAiWs = new WebSocket(`wss://api.openai.com/v1/realtime?model=${OPENAI_MODEL}`, {
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "OpenAI-Beta": "realtime=v1"
      }
    });
    // OpenAI セッションの初期設定情報を送信するヘルパー
    const sendSessionUpdate = () => {
      const sessionUpdate = {
        type: 'session.update',
        session: {
          turn_detection: { type: 'server_vad' },
          input_audio_transcription: {
            model: 'whisper-1'
          },
          input_audio_format: 'pcm16',
          output_audio_format: 'pcm16',
          voice: 'alloy',
          instructions: SYSTEM_MESSAGE,
          modalities: ["text", "audio"],
          temperature: 0.8,
          tools: [
            {
              type: "function",
              name: "get_weather",
              description: "指定された場所の天気を取得します",
              parameters: {
                type: "object",
                properties: {
                  location: {
                    type: "string",
                    description: "都道府県名, e.g. 東京都,大阪,北海道"
                  }
                },
                required: ["location"]
              }
            }
          ],
          tool_choice: 'auto',
        }
      };
      openAiWs.send(JSON.stringify(sessionUpdate));
      console.log('Sending session update:', JSON.stringify(sessionUpdate, null, 2));
      wsOpenAiOpened = true;
    };

    // OpenAI への接続が確立したときの初期処理
    openAiWs.on('open', () => {
      console.log('OpenAI Realtime APIに接続しました');
      setTimeout(sendSessionUpdate, 250); // コネクションの開設を.25秒待つ
      console.log('OpenAI の準備が整いました。');

      // セッション更新の少し後に初期メッセージを送信
      setTimeout(() => {
        // 初期メッセージを送信して会話を開始
        sendInitialGreeting();
      }, 1000); // セッション更新の後、1秒後に初期メッセージを送信
    });

    // 初期挨拶メッセージを送信する関数（シンプルバージョン）
    const sendInitialGreeting = () => {
      // 会話冒頭で OpenAI に初期挨拶をリクエスト
      console.log('初期挨拶を送信します');

      // 直接レスポンスをリクエスト
      // ユーザーからの入力がなくても、システムメッセージの指示に従って挨拶を返すはず
      openAiWs.send(JSON.stringify({
        type: 'response.create'
      }));
    };

    // Vonageから受信
    // Vonage から届くイベントや音声バイナリを処理
    connection.on('message', (message) => {

      if (Buffer.isBuffer(message)) {
        try {
          // JSON データは接続イベントなどのメタ情報
          const data = JSON.parse(message.toString());
          if (data.event === 'websocket:connected') {
            console.log('ストリームが開始されました:', data);
          }
        } catch (error) {
          // バイナリは音声データとして OpenAI に中継
          if (wsOpenAiOpened) {
            // タイムスタンプを更新（Vonage 実装では送られてこないためフォールバック）
            latestAudioTimestamp = Date.now();

            const audioAppend = {
              type: 'input_audio_buffer.append',
              audio: message.toString('base64')
            };
            openAiWs.send(JSON.stringify(audioAppend));
          }
        }
      }

    });

    // OpenAIから受信
    // OpenAI から届く各イベントを処理
    openAiWs.on('message', async (data) => {
      try {
        const response = JSON.parse(data);
        // 必要なイベントタイプだけログに出力
        if (LOG_EVENT_TYPES.includes(response.type)) {
          console.log(`Received event: ${response.type}`, response);
        }
        // セッション更新完了の通知
        if (response.type === 'session.updated') {
          console.log('Session updated successfully:', response);
        }

        // OpenAI からのアシスタント応答アイテムを記録
        if (response.type === 'conversation.item.created' && response.item.role === 'assistant') {
          conversationItemId = response.item.id;
          console.log(`会話アイテムIDを記録: ${conversationItemId}`);
        }

        // 音声応答が届いたらタイムスタンプに基づく処理と再生
        if (response.type === 'response.audio.delta' && response.delta) {
          if (!responseStartTimestamp && conversationItemId) {
            responseStartTimestamp = Date.now();
            console.log(`応答開始時間を記録: ${responseStartTimestamp}ms`);
          }

          const pcmBuffer = Buffer.from(response.delta, 'base64');

          // 960バイトに分割 (24kHz・16bit・20msフレーム = 960 bytes)
          for (let i = 0; i < pcmBuffer.length; i += 960) {
            const chunk = pcmBuffer.subarray(i, i + 960);
            if (chunk.length === 960 && isProcessingAudio) {
              // サンプリング周波数を24khzから16khzに変換
              const pcmDecoded = pcm24To16(chunk);
              connection.send(Buffer.from(pcmDecoded, 'base64'));
            }
          }
        }

        // ユーザーが話し始めたら現在の応答を中断
        if (response.type === 'input_audio_buffer.speech_started' && conversationItemId) {
          console.log(`👋 conversation cancel: ${conversationItemId}`);
          isProcessingAudio = false; // 音声処理を一時停止

          // 実際の経過時間を計算（応答開始から現在までの時間）
          let elapsedTime = 1500; // デフォルト値

          if (responseStartTimestamp && response.audio_start_ms) {
            elapsedTime = response.audio_start_ms - responseStartTimestamp;
            console.log(`応答からの経過時間: ${elapsedTime}ms`);

            // 音声が短すぎる場合は最小値を設定
            if (elapsedTime < 500) {
              elapsedTime = 500;
            }
            // 安全のために上限を設定（5秒）
            if (elapsedTime > 5000) {
              elapsedTime = 5000;
            }
          }

          // 中断リクエストを送信
          console.log(`会話を中断: item_id=${conversationItemId}, audio_end_ms=${elapsedTime}`);
          openAiWs.send(JSON.stringify({
            type: 'conversation.item.truncate',
            item_id: conversationItemId,
            content_index: 0,
            audio_end_ms: elapsedTime
          }));

          // Vonageに中断リクエストを送信
          connection.send(JSON.stringify({
            action: 'clear',
          }));

          // リセット
          conversationItemId = null;
          responseStartTimestamp = null;
        }

        // 中断処理が完了したら音声処理を再開
        if (response.type === 'conversation.item.truncated') {
          console.log('会話アイテムが正常に中断されました');
          // 処理を再開
          isProcessingAudio = true;
        }

        // ユーザーの文字起こし結果をログ
        if (response.type === 'conversation.item.input_audio_transcription.completed' && response.transcript) {
          console.log('🤖 ユーザーの音声の文字起こし: ', response.transcript);
        }

        // アシスタント側のテキスト化済み応答をログ
        if (response.type === 'response.audio_transcript.done' && response.transcript) {
          console.log('🤖 アシスタント回答: ', response.transcript);
        }

        // 関数呼び出しの結果を受け取り、実際の関数実行と応答生成
        if (response.type === 'response.function_call_arguments.done') {
          if (response.name === 'get_weather') {
            try {
              const { location } = JSON.parse(response.arguments);

              // 天気情報を取得
              const weatherInfo = await getWeatherInfo(location);

              // 関数呼び出し結果を返す
              const item = {
                type: 'conversation.item.create',
                item: {
                  type: 'function_call_output',
                  call_id: response.call_id,
                  output: JSON.stringify(weatherInfo)
                }
              };

              console.log(`🐞 function call completed: ${weatherInfo}`);
              openAiWs.send(JSON.stringify(item));

              // 応答を作成
              openAiWs.send(JSON.stringify({
                type: 'response.create',
              }));
            } catch (error) {
              console.error('天気情報の処理中にエラーが発生しました:', error);
              // エラー時には簡単なメッセージを返す
              const errorItem = {
                type: 'conversation.item.create',
                item: {
                  type: 'function_call_output',
                  call_id: response.call_id,
                  output: JSON.stringify('天気情報の取得中にエラーが発生しました。')
                }
              };
              openAiWs.send(JSON.stringify(errorItem));
              openAiWs.send(JSON.stringify({
                type: 'response.create',
              }));
            }
          }
        }

        // OpenAI 側でエラーが通知された場合
        if (response.type === 'error') {
          console.log('OpenAIエラーが発生しました', response.error.message);
        }
      } catch (error) {
        // パースなどで失敗したメッセージもログ化
        console.error('👺 OpenAIメッセージの処理中にエラーが発生しました:', error, 'Raw message:', data);
      }
    });

    // クライアント接続が切れたら OpenAI も切断
    connection.on('close', () => {
      console.log('クライアントが切断されました。');
      if (openAiWs.readyState === WebSocket.OPEN) openAiWs.close();
    });

    // OpenAI 側から切断された場合のクリーンアップ
    openAiWs.on('close', () => {
      console.log('OpenAIから切断されました');
      wsOpenAiOpened = false;
      connection.close();
    });

    // エラーはログにのみ記録
    openAiWs.on('error', (error) => {
      console.error('👺 OpenAI WebSocketエラー:', error);
    });
  });
});

// Fastify サーバー起動
fastify.listen({ port: PORT, host: '0.0.0.0' }, (err) => {
  if (err) {
    console.error(err);
    process.exit(1);
  }
  console.log(`サーバーがポート${PORT}で待機中です`);
});
