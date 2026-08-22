import WebSocket from 'ws';
import {
  FrameSplitter,
  OPENAI_FRAME_BYTES,
  VONAGE_FRAME_BYTES,
  pcm16To24,
  pcm24To16
} from '../audio/resample.js';
import { executeTool } from '../tools/index.js';
import { buildSessionUpdate } from './session.js';

const REALTIME_URL = 'wss://api.openai.com/v1/realtime';

/** 20ms フレーム 1 枚あたりの再生時間 (ms) */
const FRAME_MS = 20;

/** デバッグ時に中身まで残したい OpenAI イベント */
const VERBOSE_EVENTS = new Set([
  'session.created',
  'session.updated',
  'response.created',
  'response.done',
  'conversation.item.created',
  'conversation.item.truncated',
  'input_audio_buffer.speech_started',
  'input_audio_buffer.speech_stopped',
  'response.function_call_arguments.done'
]);

/**
 * Vonage のメディアストリームと OpenAI Realtime API を 1 通話ぶん中継する。
 *
 * 状態はすべてこの関数のスコープに閉じているので、
 * 同時に複数の通話が走っても互いに干渉しない。
 *
 * @param {object} params
 * @param {object} params.config loadConfig() の戻り値
 * @param {import('ws').WebSocket} params.connection Vonage 側の WebSocket
 * @param {{ caller: string, called: string, uuid: string }} params.call
 * @param {import('fastify').FastifyBaseLogger} params.log
 */
export const createBridge = ({ config, connection, call, log }) => {
  // ---- 通話ごとの状態 -------------------------------------------------
  let openAiReady = false;
  let greeted = false;
  /** 現在読み上げ中のアシスタント応答の item id */
  let assistantItemId = null;
  /** 現在の応答について Vonage へ送出済みの音声の長さ (ms) */
  let assistantAudioMs = 0;
  /** 割り込み直後、次の応答が始まるまで音声を捨てる */
  let discardAssistantAudio = false;

  const inbound = new FrameSplitter(VONAGE_FRAME_BYTES); // Vonage → OpenAI
  const outbound = new FrameSplitter(OPENAI_FRAME_BYTES); // OpenAI → Vonage

  const openAiWs = new WebSocket(
    `${REALTIME_URL}?model=${encodeURIComponent(config.openai.model)}`,
    { headers: { Authorization: `Bearer ${config.openai.apiKey}` } }
  );

  const sendToOpenAi = (payload) => {
    if (openAiWs.readyState === WebSocket.OPEN) {
      openAiWs.send(JSON.stringify(payload));
    }
  };

  const sendToVonage = (payload) => {
    if (connection.readyState === WebSocket.OPEN) {
      connection.send(payload);
    }
  };

  /** 新しい応答が始まったので読み上げ状態を初期化する */
  const resetPlayback = () => {
    assistantItemId = null;
    assistantAudioMs = 0;
    discardAssistantAudio = false;
    outbound.reset();
  };

  // ---- OpenAI 接続 ----------------------------------------------------
  openAiWs.on('open', () => {
    log.info('OpenAI Realtime API に接続しました');
    sendToOpenAi(buildSessionUpdate(config, call));
  });

  openAiWs.on('message', async (raw) => {
    let event;
    try {
      event = JSON.parse(raw.toString());
    } catch (error) {
      log.error({ err: error }, 'OpenAI からのメッセージを解析できませんでした');
      return;
    }

    if (VERBOSE_EVENTS.has(event.type)) {
      log.debug({ event }, `OpenAI イベント: ${event.type}`);
    }

    switch (event.type) {
      // セッション設定が反映されてから挨拶を促す (固定待ち時間に頼らない)
      case 'session.updated': {
        openAiReady = true;
        if (!greeted) {
          greeted = true;
          log.info('セッション設定が完了したので初期挨拶を要求します');
          sendToOpenAi({ type: 'response.create' });
        }
        break;
      }

      case 'response.created': {
        resetPlayback();
        break;
      }

      case 'response.output_audio.delta': {
        if (!event.delta) break;
        if (event.item_id) assistantItemId = event.item_id;
        if (discardAssistantAudio) break;

        // 24kHz の応答音声を 20ms フレームに切り出し、16kHz に落として Vonage へ流す。
        // 端数は FrameSplitter が保持するので音が欠けない。
        for (const frame of outbound.push(Buffer.from(event.delta, 'base64'))) {
          sendToVonage(pcm24To16(frame));
          assistantAudioMs += FRAME_MS;
        }
        break;
      }

      // ユーザーが話し始めたら読み上げ中の応答を打ち切る
      case 'input_audio_buffer.speech_started': {
        if (!assistantItemId || assistantAudioMs === 0) break;

        log.info({ itemId: assistantItemId, audioMs: assistantAudioMs }, '👋 応答を中断します');

        // 実際に Vonage へ送出済みの長さで切る
        sendToOpenAi({
          type: 'conversation.item.truncate',
          item_id: assistantItemId,
          content_index: 0,
          audio_end_ms: assistantAudioMs
        });
        // Vonage 側のバッファに残っている音声も破棄させる
        sendToVonage(JSON.stringify({ action: 'clear' }));

        discardAssistantAudio = true;
        outbound.reset();
        assistantItemId = null;
        assistantAudioMs = 0;
        break;
      }

      case 'conversation.item.input_audio_transcription.completed': {
        if (event.transcript) log.info({ transcript: event.transcript }, '🗣️ ユーザー');
        break;
      }

      case 'response.output_audio_transcript.done': {
        if (event.transcript) log.info({ transcript: event.transcript }, '🤖 アシスタント');
        break;
      }

      case 'response.function_call_arguments.done': {
        const { output, skipResponse } = await executeTool(event.name, event.arguments, {
          config,
          callUuid: call.uuid,
          log
        });

        log.info({ tool: event.name, output }, 'ツールを実行しました');

        sendToOpenAi({
          type: 'conversation.item.create',
          item: {
            type: 'function_call_output',
            call_id: event.call_id,
            output: JSON.stringify(output)
          }
        });

        // 転送のように通話自体が離れる操作では追加の応答を求めない
        if (!skipResponse) sendToOpenAi({ type: 'response.create' });
        break;
      }

      case 'error': {
        log.error({ error: event.error }, 'OpenAI からエラーが通知されました');
        break;
      }

      default:
        break;
    }
  });

  openAiWs.on('error', (error) => {
    log.error({ err: error }, '👺 OpenAI WebSocket エラー');
  });

  openAiWs.on('close', (code, reason) => {
    openAiReady = false;
    log.info({ code, reason: reason?.toString() }, 'OpenAI から切断されました');
    if (connection.readyState === WebSocket.OPEN) connection.close();
  });

  // ---- Vonage 接続 ----------------------------------------------------
  connection.on('message', (data, isBinary) => {
    // 制御メッセージはテキストフレームで届く
    if (!isBinary) {
      try {
        log.info({ event: JSON.parse(data.toString()) }, 'Vonage からの制御メッセージ');
      } catch {
        log.debug({ raw: data.toString() }, 'Vonage からの解析できないテキスト');
      }
      return;
    }

    if (!openAiReady) return;

    // Vonage の 16kHz 音声を 24kHz に上げてから送る。
    // Realtime API の PCM は 24kHz 固定なので、この変換を省くと
    // 音声が 1.5 倍遅く解釈され認識精度が落ちる。
    for (const frame of inbound.push(data)) {
      sendToOpenAi({
        type: 'input_audio_buffer.append',
        audio: pcm16To24(frame).toString('base64')
      });
    }
  });

  connection.on('close', () => {
    log.info('Vonage 側の接続が切断されました');
    if (openAiWs.readyState === WebSocket.OPEN) openAiWs.close();
  });

  connection.on('error', (error) => {
    log.error({ err: error }, '👺 Vonage WebSocket エラー');
  });

  return { close: () => openAiWs.close() };
};
