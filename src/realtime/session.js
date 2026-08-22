import { toolDefinitions } from '../tools/index.js';
import { OPENAI_RATE } from '../audio/resample.js';

/** Realtime API が受け付ける PCM は 24kHz 固定 */
const PCM_FORMAT = { type: 'audio/pcm', rate: OPENAI_RATE };

/** E.164 らしき番号だけを通し、それ以外は unknown 扱いにする */
const sanitizeNumber = (value) => (/^\+?[0-9]{5,15}$/.test(String(value ?? '')) ? String(value) : 'unknown');

/**
 * 通話固有の情報を system メッセージに足す。
 * @param {string} systemMessage
 * @param {{ caller: string, called: string }} call
 */
export const buildInstructions = (systemMessage, { caller, called }) =>
  [
    systemMessage,
    '',
    '電話番号情報:',
    `- 発信者番号（相手の電話番号）: ${sanitizeNumber(caller)}`,
    `- 着信番号（かけた先の番号）: ${sanitizeNumber(called)}`,
    '電話番号を聞かれた場合、先頭が81から始まる番号であれば、それを0に置き換えて、日本のローカル番号として回答してください。'
  ].join('\n');

/**
 * session.update のペイロードを組み立てる (Realtime API GA / 2025-08-28 スキーマ)。
 *
 * ベータ期の `modalities` / `input_audio_format` / トップレベル `voice` は
 * それぞれ `output_modalities` / `audio.input.format` / `audio.output.voice` に置き換わっている。
 *
 * @param {object} config loadConfig() の戻り値
 * @param {{ caller: string, called: string }} call
 */
export const buildSessionUpdate = (config, call) => ({
  type: 'session.update',
  session: {
    type: 'realtime',
    output_modalities: ['audio'],
    instructions: buildInstructions(config.systemMessage, call),
    audio: {
      input: {
        format: PCM_FORMAT,
        turn_detection: { type: 'server_vad' },
        transcription: { model: config.openai.transcriptionModel }
      },
      output: {
        format: PCM_FORMAT,
        voice: config.openai.voice
      }
    },
    tools: toolDefinitions,
    tool_choice: 'auto'
  }
});
