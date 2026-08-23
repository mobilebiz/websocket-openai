import tap from 'tap';

import { buildServer } from '../src/server.js';
import { frontConfig, testConfig, TEST_ENV } from './helpers/config.js';

const config = testConfig();
const fastify = buildServer(config);

tap.teardown(() => fastify.close());

tap.test('ヘルスチェック', async (t) => {
  await t.test('GET /', async (t) => {
    const response = await fastify.inject({ method: 'GET', url: '/' });
    t.equal(response.statusCode, 200);
    t.same(response.json(), { message: 'Vonage Voiceサーバーが稼働中です。' });
  });

  for (const url of ['/_/health', '/_/metrics']) {
    await t.test(`GET ${url}`, async (t) => {
      const response = await fastify.inject({ method: 'GET', url });
      t.equal(response.statusCode, 200);
      t.equal(response.body, 'OK');
    });
  }
});

tap.test('POST /event', async (t) => {
  const response = await fastify.inject({ method: 'POST', url: '/event' });
  t.equal(response.statusCode, 200);
  t.equal(response.body, 'OK');
});

tap.test('POST /answer', async (t) => {
  await t.test('パラメータなしでも NCCO を返す', async (t) => {
    const response = await fastify.inject({ method: 'POST', url: '/answer' });
    t.equal(response.statusCode, 200);
    t.same(response.json(), [
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
            uri: `wss://${TEST_ENV.SERVER_URL}/media-stream?caller=unknown&called=unknown&uuid=&direction=inbound`,
            contentType: 'audio/l16;rate=16000'
          }
        ]
      }
    ]);
  });

  await t.test('通話情報をクエリパラメータとして引き渡す', async (t) => {
    const response = await fastify.inject({
      method: 'POST',
      url: '/answer',
      payload: { from: '818012345678', to: '815012345678', uuid: 'call-uuid-1' }
    });
    const uri = response.json()[1].endpoint[0].uri;
    const query = new URL(uri.replace('wss://', 'https://')).searchParams;

    t.equal(query.get('caller'), '818012345678');
    t.equal(query.get('called'), '815012345678');
    t.equal(query.get('uuid'), 'call-uuid-1');
    t.equal(query.get('direction'), 'inbound', '既定は着信');
  });

  await t.test('/connect からの発信は direction=outbound を引き継ぐ', async (t) => {
    const response = await fastify.inject({
      method: 'POST',
      url: '/answer?direction=outbound',
      payload: { from: '815012345678', to: '818012345678', uuid: 'call-uuid-2' }
    });
    const uri = response.json()[1].endpoint[0].uri;
    const query = new URL(uri.replace('wss://', 'https://')).searchParams;

    t.equal(query.get('direction'), 'outbound');
  });

  await t.test('不正な direction は inbound に丸める', async (t) => {
    const response = await fastify.inject({ method: 'POST', url: '/answer?direction=../evil' });
    const uri = response.json()[1].endpoint[0].uri;
    const query = new URL(uri.replace('wss://', 'https://')).searchParams;

    t.equal(query.get('direction'), 'inbound');
  });

  await t.test('uuid 未指定でも文字列 "undefined" を埋め込まない', async (t) => {
    const response = await fastify.inject({ method: 'POST', url: '/answer' });
    t.notMatch(response.json()[1].endpoint[0].uri, 'undefined');
  });
});

tap.test('POST /connect の認証', async (t) => {
  await t.test('APIキーなしは 401', async (t) => {
    const response = await fastify.inject({
      method: 'POST',
      url: '/connect',
      payload: { to: '+818012345678' }
    });
    t.equal(response.statusCode, 401);
  });

  await t.test('APIキーが不一致なら 403', async (t) => {
    const response = await fastify.inject({
      method: 'POST',
      url: '/connect',
      headers: { 'x-api-key': 'invalid-key' },
      payload: { to: '+818012345678' }
    });
    t.equal(response.statusCode, 403);
  });

  await t.test('長さが同じでも異なるキーなら 403', async (t) => {
    const response = await fastify.inject({
      method: 'POST',
      url: '/connect',
      headers: { 'x-api-key': 'test-application-ie' },
      payload: { to: '+818012345678' }
    });
    t.equal(response.statusCode, 403);
  });

  await t.test('正しいAPIキーでも to が無ければ 400', async (t) => {
    const response = await fastify.inject({
      method: 'POST',
      url: '/connect',
      headers: { 'x-api-key': TEST_ENV.VONAGE_APPLICATION_ID },
      payload: {}
    });
    t.equal(response.statusCode, 400);
  });

  await t.test('VONAGE_APPLICATION_ID 未設定なら 500', async (t) => {
    const server = buildServer(testConfig({ VONAGE_APPLICATION_ID: undefined }));
    t.teardown(() => server.close());

    const response = await server.inject({
      method: 'POST',
      url: '/connect',
      headers: { 'x-api-key': 'anything' },
      payload: { to: '+818012345678' }
    });
    t.equal(response.statusCode, 500, 'キーを検証できないので通さない');
  });
});

tap.test('APP_ROLE=front (VCR に置く前段)', async (t) => {
  const { buildServer: build } = await import('../src/server.js');
  const front = build(frontConfig());
  t.teardown(() => front.close());

  await t.test('NCCO の WebSocket は本体 (Fly.io) を指す', async (t) => {
    const response = await front.inject({
      method: 'POST',
      url: '/answer',
      payload: { from: '818012345678', to: '815012345678', uuid: 'u-1' }
    });

    t.equal(response.statusCode, 200);
    const uri = response.json()[1].endpoint[0].uri;
    t.match(uri, 'wss://fly.example.com/media-stream', '自分自身ではなく本体へ繋がせる');
    t.notMatch(uri, 'vcr.example.com');
  });

  await t.test('音声を扱う経路は持たない', async (t) => {
    const connect = await front.inject({ method: 'POST', url: '/connect', payload: {} });
    t.equal(connect.statusCode, 404, '/connect は front には無い');

    const stream = await front.inject({ method: 'GET', url: '/media-stream' });
    t.equal(stream.statusCode, 404, '/media-stream は front には無い');
  });

  await t.test('ヘルスチェックは VCR が要求するので残す', async (t) => {
    for (const url of ['/_/health', '/_/metrics']) {
      const response = await front.inject({ method: 'GET', url });
      t.equal(response.statusCode, 200, `${url} は front でも応答する`);
    }
  });
});

tap.test('front は NCCO を返す前に本体を起こす', async (t) => {
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    return { status: 200 };
  };
  t.teardown(() => {
    globalThis.fetch = originalFetch;
  });

  const { buildServer: build } = await import('../src/server.js');

  const front = build(frontConfig());
  t.teardown(() => front.close());
  await front.inject({ method: 'POST', url: '/answer', payload: {} });
  await new Promise((resolve) => setImmediate(resolve));

  t.same(calls, ['https://fly.example.com/_/health'], '本体のヘルスチェックを叩く');

  // full では自分自身なので起こす必要がない
  calls.length = 0;
  const full = build(testConfig());
  t.teardown(() => full.close());
  await full.inject({ method: 'POST', url: '/answer', payload: {} });
  await new Promise((resolve) => setImmediate(resolve));

  t.same(calls, [], 'full では余計なリクエストを出さない');
});

tap.test('front はウェイクアップに失敗しても NCCO を返す', async (t) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error('connection refused');
  };
  t.teardown(() => {
    globalThis.fetch = originalFetch;
  });

  const { buildServer: build } = await import('../src/server.js');
  const front = build(frontConfig());
  t.teardown(() => front.close());

  const response = await front.inject({ method: 'POST', url: '/answer', payload: {} });
  t.equal(response.statusCode, 200, '本体が落ちていても通話は繋ごうとする');
  await new Promise((resolve) => setImmediate(resolve));
});
