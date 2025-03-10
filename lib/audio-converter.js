// audio-converter.js
/**
 * PCMオーディオデータのサンプリングレート変換を行うライブラリ
 */

/**
 * 24kHzから16kHzへのサンプリングレート変換を行う
 * @param {Buffer} inputBuffer - 入力PCMデータ (24kHz, 16bit)
 * @returns {Buffer} 変換後のPCMデータ (16kHz)
 */
export function pcm24To16(inputBuffer) {
  // 入力バッファのサイズチェック (24kHz・16bit・20msフレーム = 960 bytes)
  if (inputBuffer.length % 960 !== 0) {
    throw new Error('Invalid input buffer length. Must be multiple of 960 bytes');
  }

  // 16kHzに変換後のバッファサイズを計算
  const outputSize = Math.floor(inputBuffer.length * 2 / 3);
  const outputBuffer = Buffer.alloc(outputSize);

  // 3サンプルごとに2サンプルを選択
  for (let i = 0, j = 0; i < inputBuffer.length; i += 6, j += 4) {
    // 最初のサンプルをコピー
    outputBuffer.writeInt16LE(inputBuffer.readInt16LE(i), j);
    // 3つ目のサンプルをコピー
    if (i + 4 < inputBuffer.length) {
      outputBuffer.writeInt16LE(inputBuffer.readInt16LE(i + 4), j + 2);
    }
  }

  return outputBuffer;
}
