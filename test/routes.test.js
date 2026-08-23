import tap from 'tap';

import { buildServer } from '../src/server.js';
import { testConfig, TEST_ENV } from './helpers/config.js';

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
      headers: { 'x-api-key': 'test-connect-kex' },
      payload: { to: '+818012345678' }
    });
    t.equal(response.statusCode, 403);
  });

  await t.test('正しいAPIキーでも to が無ければ 400', async (t) => {
    const response = await fastify.inject({
      method: 'POST',
      url: '/connect',
      headers: { 'x-api-key': TEST_ENV.CONNECT_API_KEY },
      payload: {}
    });
    t.equal(response.statusCode, 400);
  });

  await t.test('CONNECT_API_KEY 未設定時は VONAGE_APPLICATION_ID にフォールバックする', async (t) => {
    const fallbackConfig = testConfig({ CONNECT_API_KEY: undefined });
    t.equal(fallbackConfig.connectApiKey, TEST_ENV.VONAGE_APPLICATION_ID);
    t.ok(fallbackConfig.connectApiKeyIsFallback);
  });
});
