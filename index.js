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
import { createVonageJwt } from './lib/vonage-jwt.js';
import { transferCall } from './transfer-call.js';

// Vonage Voice による音声を受け取り、OpenAI Realtime API へ転送する役割を担うサーバー

dotenv.config();

// 環境変数を読み込み、必要な値を取り出す
const {
  OPENAI_MODEL,
  SERVER_URL,
  VONAGE_APPLICATION_ID,
  VONAGE_OUTBOUND_FROM,
  VONAGE_TRANSPORT_NUMBER
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
  const apiKeyHeader = request.headers['x-api-key'];
  if (!apiKeyHeader) {
    return reply.status(401).send({ error: 'APIキーが指定されていません。' });
  }
  if (!VONAGE_APPLICATION_ID) {
    console.error('APIキー検証に必要な VONAGE_APPLICATION_ID が未設定です。');
    return reply.status(500).send({ error: 'サーバー側のAPIキー設定に問題があります。' });
  }
  if (apiKeyHeader !== VONAGE_APPLICATION_ID) {
    return reply.status(403).send({ error: 'APIキーが一致しません。' });
  }

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
  console.log('Query:', request.query);
  console.log('Body:', request.body);

  const query = request.query || {};
  const body = request.body || {};
  const from = query.from || body.from;
  const to = query.to || body.to;
  const uuid = query.uuid || body.uuid;
  const caller = from || 'unknown';
  const called = to || 'unknown';

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
          uri: `wss://${SERVER_URL}/media-stream?caller=${caller}&called=${called}&uuid=${uuid}`,
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

    const { caller, called, uuid } = req.query || {};
    console.log(`Call Context - Caller: ${caller}, Called: ${called}, UUID: ${uuid}`);

    // 会話の状態やタイミングを記録する変数
    // let responseId = null;
    let conversationItemId = null;
    let responseStartTimestamp = null;  // 応答開始時のタイムスタンプ
    let latestAudioTimestamp = 0;       // 最新の音声タイムスタンプ

    // 予約状況を管理するステート
    let reservationState = {
      name: "未設定",
      date: "未設定",
      nights: "未設定",
      guests: "未設定",
      breakfast: "未設定",
      parking: "未設定",
      roomType: "未設定",
      phone: "未設定",
      isGreetingDone: false,
      isConfirmed: false
    };

    // トークン使用量の集計用
    let sessionTokenUsage = {
      total: 0,
      input: 0,
      output: 0
    };

    // instructionを動的に生成する関数
    const getInstructions = () => {
      const baseMessage = loadSystemMessage();

      const now = new Date();
      const jstDate = now.toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" });


      let greetingInstruction = "";
      if (!reservationState.isGreetingDone) {
        greetingInstruction = `
必ず会話の冒頭で、「お電話ありがとうございます。ホテルエスペランザです。本日はどのようなご要件でしょうか？」と丁寧な日本語で挨拶してください。
`;
      } else {
        greetingInstruction = `
**挨拶は完了しています。** 「お電話ありがとうございます...」などの定型挨拶は二度と繰り返さないでください。
すぐにユーザーの要件（予約情報の聞き取り）を進めてください。
`;
      }

      let confirmationInstruction = "";
      if (reservationState.isConfirmed) {
        confirmationInstruction = `
**予約は確定済みです。** 予約内容の確認はもうしないでください。
「予約を確定しました」とだけ伝え、詳細の復唱は絶対にしないでください。
その上で、「他にご質問はありますか？」と聞き、なければ「お電話ありがとうございました。」と丁寧な日本語で挨拶してから、\`terminate_call\` を使って切断してください。
`;
      } else {
        confirmationInstruction = `
まだ予約は確定していません。すべての項目が埋まったら、内容を復唱し、ユーザーの同意を得てください。
同意が得られたら、必ず \`confirm_reservation\` ツールを呼び出してください。
`;
      }

      const statusText = `
---
現在の日時は ${jstDate} です。日付の計算は必ずこの日時を基準に行ってください。
ユーザーが「明日」や「来週の金曜日」などの相対的な日付で答えた場合は、この現在日時を基準に具体的な日付(YYYY-MM-DD)を計算し、\`update_reservation\` ツールで date を更新してください。
ユーザーに日付を聞き返す必要はありません。

現在の予約状況:
- お客様のお名前: ${reservationState.name}
- 宿泊希望日: ${reservationState.date}
- 宿泊日数: ${reservationState.nights}
- 宿泊人数: ${reservationState.guests}
- 朝食の有無: ${reservationState.breakfast}
- 駐車場の有無: ${reservationState.parking}
- お部屋の希望: ${reservationState.roomType}
- 連絡先電話番号: ${reservationState.phone}
- 予約確定状態: ${reservationState.isConfirmed ? "確定済み" : "未確定"}

※「未設定」の項目がある場合、それを優先的にユーザーに質問してください。
`;
      return baseMessage + greetingInstruction + confirmationInstruction + statusText + `

電話番号情報:
- 発信者番号（自分の電話番号）: ${caller}
- 着信番号（かけた先の番号）: ${called}
電話番号を聞かれた場合、先頭が81から始まる番号であれば、それを0に置き換えて、日本のローカル番号として回答してください。
`;
    };

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
          voice: 'alloy',
          instructions: getInstructions(),
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
            },
            {
              type: "function",
              name: "update_reservation",
              description: "予約情報を更新します。ユーザーから聞き取れた項目だけを指定してください。",
              parameters: {
                type: "object",
                properties: {
                  name: { type: "string", description: "お客様のお名前" },
                  date: { type: "string", description: "宿泊希望日 (必ず YYYY-MM-DD 形式で設定すること。例: 2024-12-25)" },
                  nights: { type: "string", description: "宿泊日数" },
                  guests: { type: "string", description: "宿泊人数" },
                  breakfast: { type: "string", description: "朝食の有無" },
                  parking: { type: "string", description: "駐車場の有無" },
                  roomType: { type: "string", description: "お部屋の希望" },
                  phone: { type: "string", description: "連絡先電話番号" }
                },
                required: []
              }
            },
            {
              type: "function",
              name: "confirm_reservation",
              description: "ユーザーが予約内容に同意し、予約を確定する場合に呼び出します。詳細の復唱はせず、確定した旨のみを伝えてください。",
              parameters: { type: "object", properties: {}, required: [] }
            },
            {
              type: "function",
              name: "terminate_call",
              description: "通話を終了します。すべての手続きが完了し、ユーザーに質問がないか確認した後に実行してください。",
              parameters: { type: "object", properties: {}, required: [] }
            },
            {
              type: "function",
              name: "transfer_call",
              description: "通話を別の電話番号に転送します",
              parameters: {
                type: "object",
                properties: {
                  destination: {
                    type: "string",
                    description: "転送先の電話番号 (E.164形式)。指定がない場合は既定の番号に転送されます。"
                  }
                },
                required: []
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
          try {
            const args = JSON.parse(response.arguments || '{}');

            if (response.name === 'get_weather') {
              const { location } = args;
              const weatherInfo = await getWeatherInfo(location);

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
              openAiWs.send(JSON.stringify({ type: 'response.create' }));
            } else if (response.name === 'update_reservation') {
              const { name, date, nights, guests, breakfast, parking, roomType, phone } = args;

              // ステートを更新（渡された値のみ更新）
              if (name) reservationState.name = name;
              if (date) reservationState.date = date;
              if (nights) reservationState.nights = nights;
              if (guests) reservationState.guests = guests;
              if (breakfast) reservationState.breakfast = breakfast;
              if (parking) reservationState.parking = parking;
              if (roomType) reservationState.roomType = roomType;
              if (phone) reservationState.phone = phone;

              console.log('📝 予約状況を更新:', reservationState);

              // 新しいステートでセッションを更新
              sendSessionUpdate();

              const item = {
                type: 'conversation.item.create',
                item: {
                  type: 'function_call_output',
                  call_id: response.call_id,
                  output: JSON.stringify({ status: 'updated', currentState: reservationState })
                }
              };

              openAiWs.send(JSON.stringify(item));
              openAiWs.send(JSON.stringify({ type: 'response.create' }));
            } else if (response.name === 'confirm_reservation') {
              console.log('📝 Reservation confirmed by user.');
              reservationState.isConfirmed = true;
              sendSessionUpdate(); // ステート更新通知

              const item = {
                type: 'conversation.item.create',
                item: {
                  type: 'function_call_output',
                  call_id: response.call_id,
                  output: JSON.stringify({ status: 'confirmed' })
                }
              };
              openAiWs.send(JSON.stringify(item));
              openAiWs.send(JSON.stringify({ type: 'response.create' }));
            } else if (response.name === 'terminate_call') {
              console.log('📞 Terminating call requested by AI');
              const item = {
                type: 'conversation.item.create',
                item: {
                  type: 'function_call_output',
                  call_id: response.call_id,
                  output: JSON.stringify({ status: 'terminating' })
                }
              };
              openAiWs.send(JSON.stringify(item));

              // AIが「さようなら」などを言い終わる時間を稼ぐため少し待ってから切断
              setTimeout(() => {
                connection.close();
              }, 3000);
            } else if (response.name === 'transfer_call') {
              const { destination } = args;
              const transferTo = destination || VONAGE_TRANSPORT_NUMBER;

              if (!transferTo) {
                const errorItem = {
                  type: 'conversation.item.create',
                  item: {
                    type: 'function_call_output',
                    call_id: response.call_id,
                    output: JSON.stringify({ error: '転送先が指定されておらず、環境変数 VONAGE_TRANSPORT_NUMBER も設定されていません。' })
                  }
                };
                openAiWs.send(JSON.stringify(errorItem));
                openAiWs.send(JSON.stringify({ type: 'response.create' }));
                return;
              }

              console.log(`📞 Transferring call to ${transferTo} (UUID: ${uuid})`);

              try {
                await transferCall(uuid, transferTo, called);
                console.log('転送成功');
                const item = {
                  type: 'conversation.item.create',
                  item: {
                    type: 'function_call_output',
                    call_id: response.call_id,
                    output: JSON.stringify({ status: 'transfer_initiated' })
                  }
                };
                openAiWs.send(JSON.stringify(item));
              } catch (err) {
                console.error('転送エラー:', err);
                const errorItem = {
                  type: 'conversation.item.create',
                  item: {
                    type: 'function_call_output',
                    call_id: response.call_id,
                    output: JSON.stringify({ error: '転送に失敗しました: ' + err.message })
                  }
                };
                openAiWs.send(JSON.stringify(errorItem));
                openAiWs.send(JSON.stringify({ type: 'response.create' }));
              }
            }
          } catch (error) {
            console.error('関数呼び出しの処理中にエラーが発生しました:', error);
            const errorItem = {
              type: 'conversation.item.create',
              item: {
                type: 'function_call_output',
                call_id: response.call_id,
                output: JSON.stringify('ツール呼び出しの処理中にエラーが発生しました。')
              }
            };
            openAiWs.send(JSON.stringify(errorItem));
            openAiWs.send(JSON.stringify({ type: 'response.create' }));
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

    // WebSocket切断時の処理
    connection.on('close', () => {
      console.log('クライアントが切断されました。');
      console.log('📊 通話終了 - OpenAI トークン使用量:');
      console.log(`  合計: ${sessionTokenUsage.total}`);
      console.log(`  入力: ${sessionTokenUsage.input}`);
      console.log(`  出力: ${sessionTokenUsage.output}`);

      const inputCost = (sessionTokenUsage.input / 1000000) * 32;
      const outputCost = (sessionTokenUsage.output / 1000000) * 64;
      const totalCost = inputCost + outputCost;
      console.log(`💰 推定コスト: $${totalCost.toFixed(4)}`);

      openAiWs.close();
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

    // OpenAIの応答完了イベントを監視して挨拶フラグを更新
    openAiWs.on('message', (data) => {
      try {
        const response = JSON.parse(data);
        if (response.type === 'response.done') {
          // 挨拶フラグの更新
          if (!reservationState.isGreetingDone) {
            reservationState.isGreetingDone = true;
            console.log('✅ 挨拶が完了しました。ステートを更新して挨拶を禁止します。');
            sendSessionUpdate();
          }

          // トークン使用量の集計
          const usage = response.response.usage;
          if (usage) {
            sessionTokenUsage.total += usage.total_tokens || 0;
            sessionTokenUsage.input += usage.input_tokens || 0;
            sessionTokenUsage.output += usage.output_tokens || 0;
          }
        }
      } catch (e) {
        // ignore
      }
    });

  });
});

// Fastify サーバー起動
if (process.env.NODE_ENV !== 'test') {
  fastify.listen({ port: PORT, host: '0.0.0.0' }, (err) => {
    if (err) {
      console.error(err);
      process.exit(1);
    }
    console.log(`サーバーがポート${PORT}で待機中です`);
  });
}

export default fastify;
