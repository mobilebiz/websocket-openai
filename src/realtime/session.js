import { toolDefinitions } from '../tools/index.js';
import { OPENAI_RATE } from '../audio/resample.js';

/** Realtime API が受け付ける PCM は 24kHz 固定 */
const PCM_FORMAT = { type: 'audio/pcm', rate: OPENAI_RATE };

/** E.164 らしき番号だけを通し、それ以外は unknown 扱いにする */
const sanitizeNumber = (value) => (/^\+?[0-9]{5,15}$/.test(String(value ?? '')) ? String(value) : 'unknown');

/**
 * 通話固有の情報を system メッセージに足す。
 *
 * Vonage の webhook は通話の向きに関わらず from=発信側 / to=着信側で届く。
 * /connect でこちらから架けた場合は発信側がこちらになるため、役割を入れ替える。
 *
 * @param {string} systemMessage
 * @param {{ caller: string, called: string, direction?: string }} call
 */
export const buildInstructions = (systemMessage, { caller, called, direction = 'inbound' }) => {
  const isOutbound = direction === 'outbound';
  const otherParty = sanitizeNumber(isOutbound ? called : caller);
  const ourNumber = sanitizeNumber(isOutbound ? caller : called);

  return [
    systemMessage,
    '',
    '電話番号情報:',
    `- 通話相手の電話番号: ${otherParty}`,
    `- こちら側の電話番号: ${ourNumber}`,
    '電話番号を聞かれた場合、先頭が81から始まる番号であれば、それを0に置き換えて、日本のローカル番号として回答してください。'
  ].join('\n');
};

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
