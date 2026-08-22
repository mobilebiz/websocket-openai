import { buildWebSocketUrl } from '../config.js';
import { VONAGE_RATE } from '../audio/resample.js';

/**
 * Vonage から呼ばれる Webhook (/event, /answer)。
 * @type {import('fastify').FastifyPluginAsync<{ config: object }>}
 */
export default async function vonageWebhookRoutes(fastify, { config }) {
  // 通話イベントの通知先。ログに残すだけ
  fastify.all('/event', async (request, reply) => {
    request.log.info({ event: request.body }, 'Vonage イベント');
    return reply.send('OK');
  });

  // 着信 (および /connect の応答) に対して NCCO を返す
  fastify.all('/answer', async (request, reply) => {
    const params = { ...(request.query ?? {}), ...(request.body ?? {}) };
    const caller = params.from || 'unknown';
    const called = params.to || 'unknown';
    const uuid = params.uuid ?? '';

    request.log.info({ caller, called, uuid }, '/answer が呼ばれました');

    const ncco = [
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
            uri: buildWebSocketUrl(config, '/media-stream', { caller, called, uuid }),
            contentType: `audio/l16;rate=${VONAGE_RATE}`
          }
        ]
      }
    ];

    return reply.type('application/json').send(ncco);
  });
}
