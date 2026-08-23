/**
 * 稼働確認と外部監視向けのエンドポイント。
 * @type {import('fastify').FastifyPluginAsync}
 */
export default async function healthRoutes(fastify) {
  fastify.get('/', async () => ({ message: 'Vonage Voiceサーバーが稼働中です。' }));

  fastify.get('/_/health', async (request, reply) => reply.send('OK'));

  fastify.get('/_/metrics', async (request, reply) => reply.send('OK'));
}
