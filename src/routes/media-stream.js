import { createBridge } from '../realtime/bridge.js';

/**
 * Vonage のメディアストリームを受け取る WebSocket ルート。
 * @type {import('fastify').FastifyPluginAsync<{ config: object }>}
 */
export default async function mediaStreamRoutes(fastify, { config }) {
  fastify.get('/media-stream', { websocket: true }, (connection, request) => {
    const {
      caller = 'unknown',
      called = 'unknown',
      uuid = '',
      direction = 'inbound'
    } = request.query ?? {};
    const log = request.log.child({ callUuid: uuid });

    log.info({ caller, called, direction }, 'Vonage クライアントが接続しました');

    createBridge({ config, connection, call: { caller, called, uuid, direction }, log });
  });
}
