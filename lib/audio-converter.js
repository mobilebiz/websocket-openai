// audio-converter.js
/**
 * PCMオーディオデータのサンプリングレート変換を行うライブラリ
 */

/**
 * 24kHzから16kHzへのサンプリングレート変換を行う
 * 線形補間法を使用して変換精度を向上
 * @param {Buffer} inputBuffer - 入力PCMデータ (24kHz, 16bit)
 * @returns {Buffer} 変換後のPCMデータ (16kHz)
 */
export function pcm24To16(inputBuffer) {
  // 入力バッファのサイズチェック (24kHz・16bit・20msフレーム = 960 bytes)
  if (inputBuffer.length % 2 !== 0) {
    throw new Error('Invalid input buffer length. Must be multiple of 2 bytes (16bit samples)');
  }

  // サンプル数計算
  const inputSamples = inputBuffer.length / 2;
  const outputSamples = Math.floor(inputSamples * 16000 / 24000);
  const outputBuffer = Buffer.alloc(outputSamples * 2);

  // 24kHzから16kHzへの変換レート比率
  const ratio = 24000 / 16000; // = 1.5

  for (let outSample = 0; outSample < outputSamples; outSample++) {
    // 入力データ上の位置（浮動小数点）を計算
    const inPos = outSample * ratio;

    // 整数位置と小数部分を取得
    const inPosInt = Math.floor(inPos);
    const fraction = inPos - inPosInt;

    // 基準となる2つのサンプルを取得（境界チェック付き）
    const sample1 = inPosInt < inputSamples ? inputBuffer.readInt16LE(inPosInt * 2) : 0;
    const sample2 = inPosInt + 1 < inputSamples ? inputBuffer.readInt16LE((inPosInt + 1) * 2) : sample1;

    // 線形補間で新しいサンプル値を計算
    const newSample = Math.round(sample1 * (1 - fraction) + sample2 * fraction);

    // 出力バッファに書き込み
    outputBuffer.writeInt16LE(newSample, outSample * 2);
  }

  return outputBuffer;
}