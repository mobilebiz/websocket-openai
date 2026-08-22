import Fastify from 'fastify';
import fastifyFormBody from '@fastify/formbody';
import fastifyWs from '@fastify/websocket';

import healthRoutes from './routes/health.js';
import vonageWebhookRoutes from './routes/vonage-webhooks.js';
import connectRoutes from './routes/connect.js';
import mediaStreamRoutes from './routes/media-stream.js';

/**
 * Fastify インスタンスを組み立てる。
 * listen は呼び出し側 (index.js) の責務なので、テストからも同じ形で使える。
 *
 * @param {object} config loadConfig() の戻り値
 * @returns {import('fastify').FastifyInstance}
 */
export const buildServer = (config) => {
  const fastify = Fastify({
    logger: {
      level: config.logLevel,
      // API キーがそのままログに出ないようにする
      redact: {
        paths: ['req.headers["x-api-key"]', 'req.headers.authorization'],
        censor: '[REDACTED]'
      },
      // 開発時は会話ログを追いやすいように整形する (本番は JSON のまま)
      ...(config.prettyLogs
        ? {
            transport: {
              target: 'pino-pretty',
              options: { translateTime: 'SYS:HH:MM:ss', ignore: 'pid,hostname' }
            }
          }
        : {})
    }
  });

  fastify.register(fastifyFormBody);
  fastify.register(fastifyWs);

  fastify.register(healthRoutes);
  fastify.register(vonageWebhookRoutes, { config });
  fastify.register(connectRoutes, { config });
  fastify.register(mediaStreamRoutes, { config });

  if (config.connectApiKeyIsFallback) {
    fastify.log.warn(
      'CONNECT_API_KEY が未設定のため /connect の認証に VONAGE_APPLICATION_ID を使用します。' +
        'アプリケーション ID は秘密情報ではないため、CONNECT_API_KEY の設定を推奨します。'
    );
  }

  return fastify;
};
