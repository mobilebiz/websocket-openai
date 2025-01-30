import Fastify from 'fastify';
import WebSocket from 'ws';
import dotenv from 'dotenv';
import fastifyFormBody from '@fastify/formbody';
import fastifyWs from '@fastify/websocket';
import { pcm24To16 } from './lib/audio-converter.js';

dotenv.config();

const { OPENAI_API_KEY, OPENAI_MODEL } = process.env;

if (!OPENAI_MODEL || !OPENAI_API_KEY) {
  console.error('環境変数が不足しています。 .envファイルで設定してください。');
  process.exit(1);
}

const fastify = Fastify();
fastify.register(fastifyFormBody);
fastify.register(fastifyWs);

const PORT = process.env.PORT || 5050;
let SERVER = "";

const LOG_EVENT_TYPES = [
  'response.content.done',
  // 'rate_limits.updated',
  'response.created',
  'response.done',
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

const SYSTEM_MESSAGE = 'あなたは明るくフレンドリーなAIアシスタントです。ユーザーが興味を持っている話題について会話し、適切な情報を提供します。ジョークや楽しい話題を交えながら、常にポジティブでいてください。';

fastify.get('/', async (request, reply) => {
  reply.send({ message: 'Vonage Voiceサーバーが稼働中です。' });
});

fastify.all('/event', async (request, reply) => {
  console.log(JSON.stringify(request.body, null, 2));
  reply.send('OK');
});

// 着信コールの処理ルート
fastify.all('/incoming-call', async (request, reply) => {
  SERVER = request.hostname;
  console.log(`🐞 /incoming-call called. ${SERVER}`);
  const nccoResponse = [
    {
      action: 'talk',
      text: '少々お待ちください。',
      language: 'ja-JP'
    },
    {
      action: 'connect',
      endpoint: [
        {
          type: 'websocket',
          uri: `wss://${SERVER}/media-stream`,
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

    });

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
    openAiWs.on('message', (data) => {
      try {
        const response = JSON.parse(data);
        if (LOG_EVENT_TYPES.includes(response.type)) {
          console.log(`Received event: ${response.type}`, response);
        }
        if (response.type === 'session.updated') {
          console.log('Session updated successfully:', response);
        }
        // if (response.type === 'response.created') {
        //   responseId = response.response.id;
        // }
        if (response.type === 'conversation.item.created' && response.item.role === 'assistant') {
          conversationItemId = response.item.id;
        }
        // if (response.type === 'input_audio_buffer.speech_started' && conversationItemId) {
        //   console.log(`conversation cancel: ${responseId}, ${conversationItemId}`);
        // openAiWs.send(JSON.stringify({
        //   type: 'response.cancel',
        //   response_id: responseId
        // }));
        // openAiWs.send(JSON.stringify({
        //   type: 'conversation.item.truncate',
        //   item_id: conversationItemId,
        //   content_index: 0,
        //   audio_end_ms: 150
        // }));
        //   responseId = null;
        //   conversationItemId = null;
        // }
        if (response.type === 'response.audio.delta' && response.delta) {
          const pcmBuffer = Buffer.from(response.delta, 'base64');

          // 960バイトに分割 (24kHz・16bit・20msフレーム = 960 bytes)
          for (let i = 0; i < pcmBuffer.length; i += 960) {
            const chunk = pcmBuffer.subarray(i, i + 960);
            if (chunk.length === 960) {
              // サンプリング周波数を24khzから16khzに変換
              const pcmDecoded = pcm24To16(chunk);
              connection.send(Buffer.from(pcmDecoded, 'base64'));
            }
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

fastify.listen({ port: PORT }, (err) => {
  if (err) {
    console.error(err);
    process.exit(1);
  }
  console.log(`サーバーがポート${PORT}で待機中です`);
});
