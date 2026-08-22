import { timingSafeEqual } from 'node:crypto';
import { createCall, VonageApiError } from '../vonage/calls.js';

/** タイミング攻撃を避けるため長さに依存しない比較を行う */
const secureEquals = (a, b) => {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
};

/**
 * 任意の番号へアウトバウンド発信する /connect。
 * @type {import('fastify').FastifyPluginAsync<{ config: object }>}
 */
export default async function connectRoutes(fastify, { config }) {
  fastify.post('/connect', async (request, reply) => {
    const apiKey = request.headers['x-api-key'];

    if (!apiKey) {
      return reply.status(401).send({ error: 'APIキーが指定されていません。' });
    }
    if (!config.connectApiKey) {
      request.log.error('CONNECT_API_KEY (または VONAGE_APPLICATION_ID) が未設定です。');
      return reply.status(500).send({ error: 'サーバー側のAPIキー設定に問題があります。' });
    }
    if (!secureEquals(apiKey, config.connectApiKey)) {
      return reply.status(403).send({ error: 'APIキーが一致しません。' });
    }

    const { to, from } = request.body ?? {};
    if (!to) {
      return reply.status(400).send({ error: '`to` は必須です。E.164形式で指定してください。' });
    }

    const outboundFrom = from || config.vonage.outboundFrom;
    if (!outboundFrom) {
      return reply
        .status(400)
        .send({ error: '`from` を指定するか VONAGE_OUTBOUND_FROM を環境変数で設定してください。' });
    }

    try {
      const result = await createCall(config, { to, from: outboundFrom });
      return reply.status(201).send(result);
    } catch (error) {
      if (error instanceof VonageApiError) {
        request.log.error({ status: error.status, body: error.body }, 'Vonage Voice API の呼び出しに失敗しました');
        return reply.status(error.status).send({
          error: 'Vonage Voice API の呼び出しに失敗しました。',
          details: error.body
        });
      }

      request.log.error({ err: error }, 'Vonage Voice API との通信に失敗しました');
      return reply.status(502).send({ error: 'Vonage Voice API との通信に失敗しました。' });
    }
  });
}
