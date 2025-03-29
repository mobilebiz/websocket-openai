import Fastify from 'fastify';
import WebSocket from 'ws';
import dotenv from 'dotenv';
import fastifyFormBody from '@fastify/formbody';
import fastifyWs from '@fastify/websocket';
import { pcm24To16 } from './lib/audio-converter.js';

dotenv.config();

const { OPENAI_MODEL, SERVER_URL } = process.env;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY_SECRET || process.env.OPENAI_API_KEY;

if (!OPENAI_MODEL || !SERVER_URL || !OPENAI_API_KEY) {
  console.error('環境変数が不足しています。 .envファイル、もしくはvcr.ymlで設定してください。');
  process.exit(1);
}

const fastify = Fastify();
fastify.register(fastifyFormBody);
fastify.register(fastifyWs);

console.debug(`VCR_PORT: ${process.env.VCR_PORT}`);
const PORT = process.env.VCR_PORT || process.env.PORT || 3000;

const LOG_EVENT_TYPES = [
  'response.content.done',
  // 'rate_limits.updated',
  'response.created',
  'response.done',
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
  'error'
];

let wsOpenAiOpened = false;
let isProcessingAudio = true;

const SYSTEM_MESSAGE = 'あなたは明るくフレンドリーなAIアシスタントです。ユーザーが興味を持っている話題について会話し、適切な情報を提供します。ジョークや楽しい話題を交えながら、常にポジティブでいてください。なお、会話はすべて日本語で行いますが、ユーザーが言語を指定した場合は、その言語で回答をしてください。また、会話の最初は「こんにちは。今日はどのようなお話をしましょうか？」と挨拶をしてください。';
// const SYSTEM_MESSAGE = 'You are a bright and friendly AI assistant. You converse about topics of interest to the user and provide relevant information. Stay positive at all times with jokes and fun topics.';

fastify.get('/', async (request, reply) => {
  reply.send({ message: 'Vonage Voiceサーバーが稼働中です。' });
});

fastify.get('/_/health', async (request, reply) => {
  reply.send('OK');
});

fastify.get('/_/metrics', async (request, reply) => {
  reply.send('OK');
});

fastify.all('/event', async (request, reply) => {
  console.log(JSON.stringify(request.body, null, 2));
  reply.send('OK');
});

// 着信コールの処理ルート
fastify.all('/incoming-call', async (request, reply) => {
  console.log(`🐞 /incoming-call called. ${SERVER_URL}`);
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

// WebSocketルート for media-stream
fastify.register(async (fastify) => {
  fastify.get('/media-stream', { websocket: true }, (connection, req) => {
    console.log('クライアントが接続されました');

    // let responseId = null;
    let conversationItemId = null;
    let responseStartTimestamp = null;  // 応答開始時のタイムスタンプ
    let latestAudioTimestamp = 0;       // 最新の音声タイムスタンプ

    const openAiWs = new WebSocket(`wss://api.openai.com/v1/realtime?model=${OPENAI_MODEL}`, {
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "OpenAI-Beta": "realtime=v1"
      }
    });
    const sendSessionUpdate = () => {
      const sessionUpdate = {
        type: 'session.update',
        session: {
          turn_detection: { type: 'server_vad' },
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
              description: "指定された場所と日付の天気を取得します",
              parameters: {
                type: "object",
                properties: {
                  location: {
                    type: "string",
                    description: "都道府県や市区町村の名前, e.g. 東京都大田区"
                  },
                  date: {
                    type: "string",
                    description: "The date in YYYY-MM-DD format, e.g. 2025/02/03"
                  }
                },
                required: ["location", "date"]
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
      console.log('初期挨拶を送信します');

      // 直接レスポンスをリクエスト
      // ユーザーからの入力がなくても、システムメッセージの指示に従って挨拶を返すはず
      openAiWs.send(JSON.stringify({
        type: 'response.create'
      }));
    };

    // Vonageから受信
    connection.on('message', (message) => {

      if (Buffer.isBuffer(message)) {
        try {
          // messageがJSON
          const data = JSON.parse(message.toString());
          if (data.event === 'websocket:connected') {
            console.log('ストリームが開始されました:', data);
          }
        } catch (error) {
          // messageがバイナリ
          if (wsOpenAiOpened) {
            // タイムスタンプを更新（実際のVonage実装ではタイムスタンプ情報がない場合のフォールバック）
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
    openAiWs.on('message', async (data) => {
      try {
        const response = JSON.parse(data);
        if (LOG_EVENT_TYPES.includes(response.type)) {
          console.log(`Received event: ${response.type}`, response);
        }
        if (response.type === 'session.updated') {
          console.log('Session updated successfully:', response);
        }

        // アシスタントの応答アイテムが作成されたとき
        if (response.type === 'conversation.item.created' && response.item.role === 'assistant') {
          conversationItemId = response.item.id;
          console.log(`会話アイテムIDを記録: ${conversationItemId}`);
        }

        // 最初の音声応答が来たときにタイムスタンプを記録
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

        // ユーザーの発話が開始されたとき
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

          // リセット
          conversationItemId = null;
          responseStartTimestamp = null;
        }

        if (response.type === 'conversation.item.truncated') {
          console.log('会話アイテムが正常に中断されました');
          // 処理を再開
          isProcessingAudio = true;
        }

        // アシスタントの音声応答をログに表示
        if (response.type === 'response.audio_transcript.done' && response.transcript) {
          console.log('🤖 アシスタント回答: ', response.transcript);
        }

        if (response.type === 'response.function_call_arguments.done') {
          if (response.name === 'get_weather') {
            const { location, date } = JSON.parse(response.arguments);
            const item = {
              type: 'conversation.item.create',
              item: {
                type: 'function_call_output',
                call_id: response.call_id,
                output: JSON.stringify(`${location}の${date}の天気は晴れです。`)
              }
            }
            console.log(`🐞 function call completed: ${location}の${date}の天気は晴れです。`);
            openAiWs.send(JSON.stringify(item));
            openAiWs.send(JSON.stringify({
              type: 'response.create',
            }));
          }
        }

        if (response.type === 'error') {
          console.log('OpenAIエラーが発生しました', response.error.message);
        }
      } catch (error) {
        console.error('👺 OpenAIメッセージの処理中にエラーが発生しました:', error, 'Raw message:', data);
      }
    });

    connection.on('close', () => {
      console.log('クライアントが切断されました。');
      if (openAiWs.readyState === WebSocket.OPEN) openAiWs.close();
    });

    openAiWs.on('close', () => {
      console.log('OpenAIから切断されました');
      wsOpenAiOpened = false;
      connection.close();
    });

    openAiWs.on('error', (error) => {
      console.error('👺 OpenAI WebSocketエラー:', error);
    });
  });
});

fastify.listen({ port: PORT, host: '0.0.0.0' }, (err) => {
  if (err) {
    console.error(err);
    process.exit(1);
  }
  console.log(`サーバーがポート${PORT}で待機中です`);
});
