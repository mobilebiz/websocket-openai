import { buildWebSocketUrl } from '../config.js';
import { VONAGE_RATE } from '../audio/resample.js';

/** 本体を起こすリクエストを諦めるまでの時間 */
const WAKE_TIMEOUT_MS = 10_000;

/**
 * front として動いているとき、NCCO を返す前に本体 (Fly.io) を起こしておく。
 *
 * NCCO は上から順に実行されるので、`talk` の読み上げが終わってから WebSocket 接続に進む。
 * ここで先に叩いておくと、その読み上げ時間をそのまま本体の起動時間に充てられる。
 * 応答は待たない。answer_url には 5 秒の制限があり、待つと本末転倒になる。
 *
 * @param {object} config
 * @param {import('fastify').FastifyBaseLogger} log
 */
const wakeMediaStreamHost = (config, log) => {
  if (config.appRole !== 'front') return;

  const host = config.mediaStreamHost.replace(/^https?:\/\//, '');
  const url = `https://${host}/_/health`;

  fetch(url, { signal: AbortSignal.timeout(WAKE_TIMEOUT_MS) })
    .then((response) => log.info({ url, status: response.status }, '本体を起こしました'))
    .catch((error) => log.warn({ url, err: error.message }, '本体のウェイクアップに失敗しました'));
};

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
    // /connect からの発信のみ outbound。着信は既定の inbound
    const direction = params.direction === 'outbound' ? 'outbound' : 'inbound';

    request.log.info({ caller, called, uuid, direction }, '/answer が呼ばれました');

    wakeMediaStreamHost(config, request.log);

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
            uri: buildWebSocketUrl(config, '/media-stream', { caller, called, uuid, direction }),
            contentType: `audio/l16;rate=${VONAGE_RATE}`
          }
        ]
      }
    ];

    return reply.type('application/json').send(ncco);
  });
}
