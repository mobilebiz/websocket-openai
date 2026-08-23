import tap from 'tap';

import { OPENAI_FRAME_BYTES, VONAGE_FRAME_BYTES } from '../src/audio/resample.js';
import { testConfig } from './helpers/config.js';
import { FakeSocket, silentLog } from './helpers/fake-socket.js';

/** ws を差し替えた bridge を読み込み、Vonage 側と OpenAI 側のソケットを返す */
const setup = async (t, { config = testConfig() } = {}) => {
  const { createBridge } = await t.mockImport('../src/realtime/bridge.js', {
    ws: { default: FakeSocket, WebSocket: FakeSocket }
  });

  const vonage = new FakeSocket();
  createBridge({
    config,
    connection: vonage,
    call: { caller: '818012345678', called: '815012345678', uuid: 'call-uuid-1' },
    log: silentLog
  });
  const openai = FakeSocket.last; // bridge が内部で生成したソケット

  return { vonage, openai };
};

/** OpenAI 接続確立〜セッション確定までを進める */
const handshake = (openai) => {
  openai.emit('open');
  openai.receive({ type: 'session.updated' });
};

const base64Audio = (bytes) => Buffer.alloc(bytes, 1).toString('base64');

tap.test('接続時に GA スキーマの session.update を送る', async (t) => {
  const { openai } = await setup(t);
  openai.emit('open');

  const [first] = openai.sentJson();
  t.equal(first.type, 'session.update');
  t.equal(first.session.type, 'realtime');
  t.match(openai.url, /wss:\/\/api\.openai\.com\/v1\/realtime\?model=gpt-realtime/);
  t.notOk(openai.options.headers['OpenAI-Beta'], 'GA ではベータヘッダーを送らない');
  t.match(openai.options.headers.Authorization, /^Bearer /);
});

tap.test('session.updated を受けてから挨拶を要求する', async (t) => {
  const { openai } = await setup(t);
  openai.emit('open');

  t.notOk(
    openai.sentJson().some((event) => event.type === 'response.create'),
    'セッション確定前に response.create を送らない'
  );

  openai.receive({ type: 'session.updated' });
  t.equal(
    openai.sentJson().filter((event) => event.type === 'response.create').length,
    1,
    'session.updated 後に一度だけ挨拶を要求する'
  );

  openai.receive({ type: 'session.updated' });
  t.equal(
    openai.sentJson().filter((event) => event.type === 'response.create').length,
    1,
    'session.updated が再送されても挨拶は増えない'
  );
});

tap.test('Vonage の 16kHz 音声を 24kHz に変換して送る', async (t) => {
  const { vonage, openai } = await setup(t);
  handshake(openai);

  vonage.emit('message', Buffer.alloc(VONAGE_FRAME_BYTES), true);

  const appends = openai.sentJson().filter((event) => event.type === 'input_audio_buffer.append');
  t.equal(appends.length, 1);
  t.equal(
    Buffer.from(appends[0].audio, 'base64').length,
    OPENAI_FRAME_BYTES,
    '640 バイトが 960 バイトにアップサンプリングされる'
  );
});

tap.test('セッション確定前の音声は送らない', async (t) => {
  const { vonage, openai } = await setup(t);
  vonage.emit('message', Buffer.alloc(VONAGE_FRAME_BYTES), true);

  t.notOk(
    openai.sentJson().some((event) => event.type === 'input_audio_buffer.append'),
    'OpenAI の準備前に音声を送らない'
  );
});

tap.test('テキストフレームは音声として扱わない', async (t) => {
  const { vonage, openai } = await setup(t);
  handshake(openai);

  vonage.emit('message', Buffer.from(JSON.stringify({ event: 'websocket:connected' })), false);

  t.notOk(
    openai.sentJson().some((event) => event.type === 'input_audio_buffer.append'),
    '制御メッセージは中継しない'
  );
});

tap.test('応答音声を 16kHz に変換して Vonage へ流す', async (t) => {
  const { vonage, openai } = await setup(t);
  handshake(openai);

  openai.receive({ type: 'response.created' });
  openai.receive({
    type: 'response.output_audio.delta',
    item_id: 'item-1',
    delta: base64Audio(OPENAI_FRAME_BYTES * 2)
  });

  const frames = vonage.sentBinary();
  t.equal(frames.length, 2, '960 バイト x2 で 2 フレーム送出される');
  t.equal(frames[0].length, VONAGE_FRAME_BYTES, '各フレームは 640 バイト');
});

tap.test('フレーム端数をまたいでも音声が欠けない', async (t) => {
  const { vonage, openai } = await setup(t);
  handshake(openai);
  openai.receive({ type: 'response.created' });

  // 960 の倍数にならない分割で届いても、合計は保たれる
  for (const size of [500, 500, 900, 1100]) {
    openai.receive({ type: 'response.output_audio.delta', item_id: 'item-1', delta: base64Audio(size) });
  }

  const total = vonage.sentBinary().reduce((sum, frame) => sum + frame.length, 0);
  const expectedFrames = Math.floor(3000 / OPENAI_FRAME_BYTES);
  t.equal(total, expectedFrames * VONAGE_FRAME_BYTES, '旧実装では捨てられていた端数が保持される');
});

tap.test('応答終了時に端数フレームをフラッシュして末尾を欠けさせない', async (t) => {
  const { vonage, openai } = await setup(t);
  handshake(openai);
  openai.receive({ type: 'response.created' });

  // 960 の倍数にならない長さで応答が終わる
  openai.receive({
    type: 'response.output_audio.delta',
    item_id: 'item-1',
    delta: base64Audio(OPENAI_FRAME_BYTES + 300)
  });
  t.equal(vonage.sentBinary().length, 1, 'この時点では端数が残っている');

  openai.receive({ type: 'response.output_audio.done' });
  t.equal(vonage.sentBinary().length, 2, '端数が無音パディングされて送出される');
  t.equal(vonage.sentBinary().at(-1).length, VONAGE_FRAME_BYTES, '最終フレームも 640 バイト');
});

tap.test('割り込み後の応答終了では端数を流さない', async (t) => {
  const { vonage, openai } = await setup(t);
  handshake(openai);
  openai.receive({ type: 'response.created' });
  openai.receive({
    type: 'response.output_audio.delta',
    item_id: 'item-1',
    delta: base64Audio(OPENAI_FRAME_BYTES + 300)
  });
  openai.receive({ type: 'input_audio_buffer.speech_started' });

  const before = vonage.sentBinary().length;
  openai.receive({ type: 'response.output_audio.done' });
  t.equal(vonage.sentBinary().length, before, '中断済みの応答の端数は送らない');
});

tap.test('20ms 未満しか出していなくても割り込みで後続音声を止める', async (t) => {
  const { vonage, openai } = await setup(t);
  handshake(openai);
  openai.receive({ type: 'response.created' });

  // 1 フレームに満たない delta。assistantAudioMs は 0 のまま
  openai.receive({
    type: 'response.output_audio.delta',
    item_id: 'item-1',
    delta: base64Audio(400)
  });
  t.equal(vonage.sentBinary().length, 0, 'まだ音声は出ていない');

  openai.receive({ type: 'input_audio_buffer.speech_started' });

  t.notOk(
    openai.sentJson().some((event) => event.type === 'conversation.item.truncate'),
    '送出済みの音声が無いので truncate は送らない'
  );
  const cleared = vonage.sent.filter((p) => typeof p === 'string').map((p) => JSON.parse(p));
  t.same(cleared.at(-1), { action: 'clear' }, 'Vonage 側のバッファは破棄させる');

  // キャンセルと競合して届く残りの delta が、端数を完成させて流れてしまわないこと
  openai.receive({
    type: 'response.output_audio.delta',
    item_id: 'item-1',
    delta: base64Audio(OPENAI_FRAME_BYTES)
  });
  t.equal(vonage.sentBinary().length, 0, 'ユーザーの発話中に古い音声を流さない');
});

tap.test('割り込み時に送出済みの長さで truncate する', async (t) => {
  const { vonage, openai } = await setup(t);
  handshake(openai);
  openai.receive({ type: 'response.created' });

  // 3 フレーム = 60ms ぶん送出させる
  openai.receive({
    type: 'response.output_audio.delta',
    item_id: 'item-1',
    delta: base64Audio(OPENAI_FRAME_BYTES * 3)
  });
  openai.receive({ type: 'input_audio_buffer.speech_started' });

  const truncate = openai.sentJson().find((event) => event.type === 'conversation.item.truncate');
  t.ok(truncate, 'truncate を送る');
  t.equal(truncate.item_id, 'item-1');
  t.equal(truncate.content_index, 0);
  t.equal(truncate.audio_end_ms, 60, '実際に Vonage へ送った長さと一致する');

  const clear = vonage.sent.filter((payload) => typeof payload === 'string').map((p) => JSON.parse(p));
  t.same(clear.at(-1), { action: 'clear' }, 'Vonage 側のバッファも破棄させる');
});

tap.test('読み上げていなければ割り込みで truncate しない', async (t) => {
  const { openai } = await setup(t);
  handshake(openai);

  openai.receive({ type: 'input_audio_buffer.speech_started' });

  t.notOk(
    openai.sentJson().some((event) => event.type === 'conversation.item.truncate'),
    '未再生の状態では truncate を送らない'
  );
});

tap.test('割り込み後の残り音声は捨て、次の応答で再開する', async (t) => {
  const { vonage, openai } = await setup(t);
  handshake(openai);
  openai.receive({ type: 'response.created' });
  openai.receive({
    type: 'response.output_audio.delta',
    item_id: 'item-1',
    delta: base64Audio(OPENAI_FRAME_BYTES)
  });
  openai.receive({ type: 'input_audio_buffer.speech_started' });

  const afterInterrupt = vonage.sentBinary().length;
  openai.receive({
    type: 'response.output_audio.delta',
    item_id: 'item-1',
    delta: base64Audio(OPENAI_FRAME_BYTES)
  });
  t.equal(vonage.sentBinary().length, afterInterrupt, '中断した応答の続きは流さない');

  // 新しい応答が始まれば再開する (truncated が届かなくても復帰する)
  openai.receive({ type: 'response.created' });
  openai.receive({
    type: 'response.output_audio.delta',
    item_id: 'item-2',
    delta: base64Audio(OPENAI_FRAME_BYTES)
  });
  t.equal(vonage.sentBinary().length, afterInterrupt + 1, '次の応答は再生される');
});

tap.test('ツール呼び出しの結果を返し、応答生成を促す', async (t) => {
  const { openai } = await setup(t);
  handshake(openai);

  openai.receive({
    type: 'response.function_call_arguments.done',
    name: 'put_name',
    call_id: 'call-1',
    arguments: JSON.stringify({ name: '高橋' })
  });
  await new Promise((resolve) => setImmediate(resolve)); // ハンドラは非同期

  const output = openai.sentJson().find((event) => event.type === 'conversation.item.create');
  t.equal(output.item.type, 'function_call_output');
  t.equal(output.item.call_id, 'call-1');
  t.same(JSON.parse(output.item.output), { status: 'ok' });

  const responses = openai.sentJson().filter((event) => event.type === 'response.create');
  t.equal(responses.length, 2, '挨拶ぶんとツール結果ぶんで 2 回');
});

tap.test('未知のツールでも接続を落とさない', async (t) => {
  const { openai } = await setup(t);
  handshake(openai);

  openai.receive({
    type: 'response.function_call_arguments.done',
    name: 'unknown_tool',
    call_id: 'call-2',
    arguments: '{}'
  });
  await new Promise((resolve) => setImmediate(resolve));

  const output = openai.sentJson().find((event) => event.type === 'conversation.item.create');
  t.match(JSON.parse(output.item.output), { error: /未知のツール/ });
});

tap.test('片側が切れたらもう片側も閉じる', async (t) => {
  const { vonage, openai } = await setup(t);
  handshake(openai);

  vonage.emit('close');
  t.equal(openai.readyState, FakeSocket.CLOSED, 'Vonage 切断で OpenAI も閉じる');
});

tap.test('接続確立前に切られても OpenAI 側を閉じる', async (t) => {
  const { vonage, openai } = await setup(t);

  // OpenAI への接続がまだ CONNECTING の状態で通話が切れる
  openai.readyState = FakeSocket.CONNECTING;
  vonage.emit('close');

  t.equal(openai.readyState, FakeSocket.CLOSED, 'CONNECTING のまま放置してセッションを残さない');
});

tap.test('通話ごとに状態が独立している', async (t) => {
  const { createBridge } = await t.mockImport('../src/realtime/bridge.js', {
    ws: { default: FakeSocket, WebSocket: FakeSocket }
  });
  const config = testConfig();

  const makeCall = (uuid) => {
    const vonage = new FakeSocket();
    createBridge({ config, connection: vonage, call: { caller: 'a', called: 'b', uuid }, log: silentLog });
    const openai = FakeSocket.last;
    openai.emit('open');
    openai.receive({ type: 'session.updated' });
    return { vonage, openai };
  };

  const callA = makeCall('uuid-a');
  const callB = makeCall('uuid-b');

  // A だけ割り込みを起こす
  callA.openai.receive({ type: 'response.created' });
  callA.openai.receive({
    type: 'response.output_audio.delta',
    item_id: 'item-a',
    delta: base64Audio(OPENAI_FRAME_BYTES)
  });
  callA.openai.receive({ type: 'input_audio_buffer.speech_started' });

  // B は影響を受けずに再生を続けられる
  callB.openai.receive({ type: 'response.created' });
  callB.openai.receive({
    type: 'response.output_audio.delta',
    item_id: 'item-b',
    delta: base64Audio(OPENAI_FRAME_BYTES)
  });

  t.equal(callB.vonage.sentBinary().length, 1, '別の通話の割り込みで音声が止まらない');
  t.notOk(
    callB.openai.sentJson().some((event) => event.type === 'conversation.item.truncate'),
    '別の通話の truncate が混ざらない'
  );
});
