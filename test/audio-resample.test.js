import tap from 'tap';

import {
  FrameSplitter,
  OPENAI_FRAME_BYTES,
  VONAGE_FRAME_BYTES,
  pcm16To24,
  pcm24To16,
  resamplePcm16
} from '../src/audio/resample.js';

/** サンプル値が連番になった PCM16LE バッファを作る */
const createBuffer = (bytes) => {
  const buffer = Buffer.alloc(bytes);
  for (let i = 0; i < bytes; i += 2) buffer.writeInt16LE(i / 2, i);
  return buffer;
};

/** 指定周波数の正弦波を作る */
const createSine = (samples, rate, frequency) => {
  const buffer = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) {
    buffer.writeInt16LE(Math.round(16000 * Math.sin((2 * Math.PI * frequency * i) / rate)), i * 2);
  }
  return buffer;
};

tap.test('フレームサイズの定数', async (t) => {
  t.equal(VONAGE_FRAME_BYTES, 640, '16kHz の 20ms フレームは 640 バイト');
  t.equal(OPENAI_FRAME_BYTES, 960, '24kHz の 20ms フレームは 960 バイト');
});

tap.test('pcm24To16 (OpenAI → Vonage)', async (t) => {
  const input = createBuffer(OPENAI_FRAME_BYTES);
  const output = pcm24To16(input);

  t.equal(output.length, VONAGE_FRAME_BYTES, '960 バイト入力で 640 バイト出力');
  t.equal(output.readInt16LE(0), input.readInt16LE(0), '先頭サンプルは一致する');
  t.equal(output.readInt16LE(2), input.readInt16LE(4), '2 番目は入力の 3 サンプル目に対応する');

  t.throws(
    () => pcm24To16(createBuffer(950)),
    new Error('Invalid input buffer length. Must be multiple of 960 bytes'),
    '960 の倍数でなければエラー'
  );
});

tap.test('pcm16To24 (Vonage → OpenAI)', async (t) => {
  const input = createBuffer(VONAGE_FRAME_BYTES);
  const output = pcm16To24(input);

  t.equal(output.length, OPENAI_FRAME_BYTES, '640 バイト入力で 960 バイト出力');
  t.equal(output.readInt16LE(0), input.readInt16LE(0), '先頭サンプルは一致する');

  t.throws(
    () => pcm16To24(createBuffer(630)),
    new Error('Invalid input buffer length. Must be multiple of 640 bytes'),
    '640 の倍数でなければエラー'
  );
});

tap.test('往復変換で波形の概形が保たれる', async (t) => {
  // 電話帯域の 400Hz は 16kHz→24kHz→16kHz を通しても大きく崩れないはず
  const original = createSine(320, 16000, 400);
  const roundTrip = pcm24To16(pcm16To24(original));

  t.equal(roundTrip.length, original.length, '長さが戻る');

  let maxError = 0;
  for (let i = 0; i < original.length; i += 2) {
    maxError = Math.max(maxError, Math.abs(original.readInt16LE(i) - roundTrip.readInt16LE(i)));
  }
  // 線形補間なので完全一致はしないが、振幅 16000 に対して十分小さいこと
  t.ok(maxError < 1600, `最大誤差が振幅の 10% 未満であること (実測 ${maxError})`);
});

tap.test('resamplePcm16', async (t) => {
  const input = createBuffer(640);

  t.same(resamplePcm16(input, 16000, 16000), input, '同一レートならそのまま返す');
  t.throws(() => resamplePcm16(Buffer.alloc(3), 16000, 24000), '奇数バイトはエラー');
});

tap.test('FrameSplitter は端数を保持して音声を欠落させない', async (t) => {
  const splitter = new FrameSplitter(960);

  t.same(splitter.push(Buffer.alloc(500)), [], '1 フレームに満たなければ何も返さない');

  const frames = splitter.push(Buffer.alloc(500));
  t.equal(frames.length, 1, '合計 1000 バイトで 1 フレーム分が確定する');
  t.equal(frames[0].length, 960);

  const more = splitter.push(Buffer.alloc(920));
  t.equal(more.length, 1, '残り 40 バイトと合わせて次のフレームが確定する');

  splitter.reset();
  t.same(splitter.push(Buffer.alloc(100)), [], 'reset 後は端数が破棄されている');
});

tap.test('FrameSplitter.flush は端数を無音で埋めて取り出す', async (t) => {
  const splitter = new FrameSplitter(960);

  t.equal(splitter.flush(), null, '端数が無ければ null');

  splitter.push(Buffer.alloc(100, 7));
  const frame = splitter.flush();

  t.equal(frame.length, 960, '1 フレームぶんに広げる');
  t.equal(frame[0], 7, '元データは先頭に残る');
  t.equal(frame[99], 7);
  t.equal(frame[100], 0, '残りは無音で埋める');

  t.equal(splitter.flush(), null, 'flush 後は端数が空になる');
});

tap.test('連結された音声が分割されても総量が保たれる', async (t) => {
  const splitter = new FrameSplitter(960);
  const chunks = [1500, 300, 2000, 700]; // 合計 4500 バイト
  let emitted = 0;

  for (const size of chunks) {
    for (const frame of splitter.push(Buffer.alloc(size))) emitted += frame.length;
  }

  t.equal(emitted, Math.floor(4500 / 960) * 960, '確定したフレームの合計が一致する');
});
