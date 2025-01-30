import tap from 'tap';
import Fastify from 'fastify';
import fastifyFormBody from '@fastify/formbody';
import fastifyWs from '@fastify/websocket';
import { pcm24To16 } from '../lib/audio-converter.js';
import dotenv from 'dotenv';

dotenv.config();

const { OPENAI_API_KEY, OPENAI_MODEL } = process.env;

tap.test('Fastify server', async t => {
  const fastify = Fastify();
  fastify.register(fastifyFormBody);
  fastify.register(fastifyWs);

  // Register your routes here
  fastify.get('/', async (request, reply) => {
    reply.send({ message: 'Vonage Voiceサーバーが稼働中です。' });
  });

  // Event webhook
  fastify.all('/event', async (request, reply) => {
    console.log(JSON.stringify(request.body, null, 2));
    reply.send('OK');
  });

  fastify.all('/incoming-call', async (request, reply) => {
    const nccoResponse = [
      {
        action: 'talk',
        text: '少々お待ちください。',
        language: 'ja-JP'
      },
      {
        action: 'connect',
        endpoint: [
          {
            type: 'websocket',
            uri: `wss://localhost/media-stream`,
            contentType: 'audio/l16;rate=16000',
          }
        ]
      }
    ];

    reply.type('application/json').send(nccoResponse);
  });

  await fastify.listen({ port: 0 });

  t.teardown(() => fastify.close());

  t.test('GET /', async t => {
    const response = await fastify.inject({
      method: 'GET',
      url: '/'
    });

    t.equal(response.statusCode, 200, 'returns a status code of 200');
    t.same(response.json(), { message: 'Vonage Voiceサーバーが稼働中です。' }, 'returns the correct message');
  });

  t.test('POST /event', async t => {
    const response = await fastify.inject({
      method: 'POST',
      url: '/event'
    });

    t.equal(response.statusCode, 200, 'returns a status code of 200');
    t.same(response.body, 'OK', 'returns the correct message');
  });

  t.test('POST /incoming-call', async t => {
    const response = await fastify.inject({
      method: 'POST',
      url: '/incoming-call'
    });

    t.equal(response.statusCode, 200, 'returns a status code of 200');
    t.same(response.json(), [
      {
        action: 'talk',
        text: '少々お待ちください。',
        language: 'ja-JP'
      },
      {
        action: 'connect',
        endpoint: [
          {
            type: 'websocket',
            uri: `wss://localhost/media-stream`,
            contentType: 'audio/l16;rate=16000',
          }
        ]
      }
    ], 'returns the correct NCCO response');
  });
});