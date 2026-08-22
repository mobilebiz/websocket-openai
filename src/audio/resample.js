/**
 * PCM 16bit リトルエンディアン・モノラル音声のサンプリングレート変換。
 *
 * Vonage の WebSocket は 16kHz、OpenAI Realtime API は 24kHz 固定なので、
 * 双方向で変換が必要になる。
 */

/** 20ms フレームのバイト数 (16bit モノラル) */
export const frameBytes = (rate) => (rate / 1000) * 20 * 2;

export const VONAGE_RATE = 16000;
export const OPENAI_RATE = 24000;

/** Vonage の 20ms フレーム = 640 バイト */
export const VONAGE_FRAME_BYTES = frameBytes(VONAGE_RATE);
/** OpenAI の 20ms フレーム = 960 バイト */
export const OPENAI_FRAME_BYTES = frameBytes(OPENAI_RATE);

/**
 * 線形補間によるリサンプリング。
 *
 * フレーム単位で独立に処理するため境界で僅かな不連続が生じるが、
 * 電話帯域の音声では実用上問題にならない。
 *
 * @param {Buffer} input PCM16LE モノラル
 * @param {number} inputRate 入力サンプリングレート (Hz)
 * @param {number} outputRate 出力サンプリングレート (Hz)
 * @returns {Buffer} 変換後の PCM16LE
 */
export function resamplePcm16(input, inputRate, outputRate) {
  if (input.length % 2 !== 0) {
    throw new Error('PCM16 のバッファ長は 2 の倍数である必要があります');
  }
  if (inputRate === outputRate) return Buffer.from(input);

  const inputSamples = input.length / 2;
  const outputSamples = Math.floor((inputSamples * outputRate) / inputRate);
  const output = Buffer.alloc(outputSamples * 2);
  const ratio = inputRate / outputRate;

  for (let i = 0; i < outputSamples; i++) {
    const position = i * ratio;
    const index = Math.floor(position);
    const fraction = position - index;

    const current = index < inputSamples ? input.readInt16LE(index * 2) : 0;
    const next = index + 1 < inputSamples ? input.readInt16LE((index + 1) * 2) : current;

    output.writeInt16LE(Math.round(current * (1 - fraction) + next * fraction), i * 2);
  }

  return output;
}

/**
 * OpenAI (24kHz) → Vonage (16kHz)
 * @param {Buffer} input 960 バイトの倍数
 */
export function pcm24To16(input) {
  if (input.length % OPENAI_FRAME_BYTES !== 0) {
    throw new Error(`Invalid input buffer length. Must be multiple of ${OPENAI_FRAME_BYTES} bytes`);
  }
  return resamplePcm16(input, OPENAI_RATE, VONAGE_RATE);
}

/**
 * Vonage (16kHz) → OpenAI (24kHz)
 * @param {Buffer} input 640 バイトの倍数
 */
export function pcm16To24(input) {
  if (input.length % VONAGE_FRAME_BYTES !== 0) {
    throw new Error(`Invalid input buffer length. Must be multiple of ${VONAGE_FRAME_BYTES} bytes`);
  }
  return resamplePcm16(input, VONAGE_RATE, OPENAI_RATE);
}

/**
 * 可変長で届くバイト列を固定サイズのフレームに切り出す。
 * 端数は次回の呼び出しまで保持するため、音声が欠けない。
 */
export class FrameSplitter {
  #frameSize;
  #residual = Buffer.alloc(0);

  constructor(frameSize) {
    this.#frameSize = frameSize;
  }

  /**
   * @param {Buffer} chunk
   * @returns {Buffer[]} 切り出せた完全なフレームの配列
   */
  push(chunk) {
    const buffer = this.#residual.length ? Buffer.concat([this.#residual, chunk]) : chunk;
    const frameCount = Math.floor(buffer.length / this.#frameSize);
    const frames = [];

    for (let i = 0; i < frameCount; i++) {
      frames.push(buffer.subarray(i * this.#frameSize, (i + 1) * this.#frameSize));
    }

    this.#residual = buffer.subarray(frameCount * this.#frameSize);
    return frames;
  }

  /** 保持している端数を破棄する (割り込み時など) */
  reset() {
    this.#residual = Buffer.alloc(0);
  }
}
