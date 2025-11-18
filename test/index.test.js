import tap from 'tap';

process.env.NODE_ENV = 'test';

const { default: fastify } = await import('../index.js');

tap.teardown(() => fastify.close());

tap.test('Fastify server', async t => {
  await t.test('GET /', async t => {
    const response = await fastify.inject({ method: 'GET', url: '/' });
    t.equal(response.statusCode, 200, 'returns a status code of 200');
    t.same(response.json(), { message: 'Vonage Voiceサーバーが稼働中です。' }, 'returns the correct message');
  });

  await t.test('GET /_/health', async t => {
    const response = await fastify.inject({ method: 'GET', url: '/_/health' });
    t.equal(response.statusCode, 200, 'returns a status code of 200');
    t.same(response.body, 'OK', 'returns the correct message');
  });

  await t.test('GET /_/metrics', async t => {
    const response = await fastify.inject({ method: 'GET', url: '/_/metrics' });
    t.equal(response.statusCode, 200, 'returns a status code of 200');
    t.same(response.body, 'OK', 'returns the correct message');
  });

  await t.test('POST /event', async t => {
    const response = await fastify.inject({ method: 'POST', url: '/event' });
    t.equal(response.statusCode, 200, 'returns a status code of 200');
    t.same(response.body, 'OK', 'returns the correct message');
  });

  await t.test('POST /answer', async t => {
    const response = await fastify.inject({ method: 'POST', url: '/answer' });
    t.equal(response.statusCode, 200, 'returns a status code of 200');
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
            uri: `wss://${process.env.SERVER_URL}/media-stream`,
            contentType: 'audio/l16;rate=16000',
          }
        ]
      }
    ], 'returns the correct NCCO response');
  });

  await t.test('POST /connect without API key returns 401', async t => {
    const response = await fastify.inject({
      method: 'POST',
      url: '/connect',
      payload: { to: '+818012345678' }
    });
    t.equal(response.statusCode, 401, 'requires API key');
  });

  await t.test('POST /connect with invalid API key returns 403', async t => {
    const response = await fastify.inject({
      method: 'POST',
      url: '/connect',
      headers: { 'x-api-key': 'invalid-key' },
      payload: { to: '+818012345678' }
    });
    t.equal(response.statusCode, 403, 'rejects invalid API key');
  });
});