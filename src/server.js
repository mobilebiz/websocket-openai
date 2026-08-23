import { createRequire } from 'node:module';
import Fastify from 'fastify';
import fastifyFormBody from '@fastify/formbody';
import fastifyWs from '@fastify/websocket';

import healthRoutes from './routes/health.js';
import vonageWebhookRoutes from './routes/vonage-webhooks.js';
import connectRoutes from './routes/connect.js';
import mediaStreamRoutes from './routes/media-stream.js';

const require = createRequire(import.meta.url);

/**
 * pino-pretty は devDependency なので、本番相当の環境には入っていない。
 * NODE_ENV を設定しない実行環境 (VCR など) でも落ちないよう、実在を確かめてから使う。
 */
const canPrettyPrint = () => {
  try {
    require.resolve('pino-pretty');
    return true;
  } catch {
    return false;
  }
};

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
      ...(config.prettyLogs && canPrettyPrint()
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

  // ヘルスチェックと NCCO の返却は front / full の両方で必要
  fastify.register(healthRoutes);
  fastify.register(vonageWebhookRoutes, { config });

  // front (VCR) は NCCO を返すだけなので、音声を扱う経路は持たない
  if (config.appRole === 'full') {
    fastify.register(fastifyWs);
    fastify.register(connectRoutes, { config });
    fastify.register(mediaStreamRoutes, { config });
  }

  return fastify;
};
