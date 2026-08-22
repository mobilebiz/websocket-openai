import { transferCall } from '../vonage/calls.js';

export const definition = {
  type: 'function',
  name: 'transfer_call',
  description: '通話を別の電話番号に転送します',
  parameters: {
    type: 'object',
    properties: {
      destination: {
        type: 'string',
        description: '転送先の電話番号 (E.164形式)。指定がない場合は既定の番号に転送されます。'
      }
    },
    required: []
  }
};

/**
 * 現在の通話を転送する。
 * @param {{ destination?: string }} args
 * @param {{ config: object, callUuid: string, log: import('fastify').FastifyBaseLogger }} context
 */
export const handler = async ({ destination }, { config, callUuid, log }) => {
  const to = destination || config.vonage.transferTo;

  if (!to) {
    return {
      error: '転送先が指定されておらず、環境変数 VONAGE_TRANSPORT_NUMBER も設定されていません。'
    };
  }
  if (!callUuid) {
    return { error: '通話 UUID を取得できなかったため転送できません。' };
  }

  log.info({ to, callUuid }, '📞 通話を転送します');
  await transferCall(config, { uuid: callUuid, to, from: config.vonage.outboundFrom });

  return { status: 'transfer_initiated' };
};

/**
 * 転送が成功すると通話は別の宛先へ繋がるため、
 * OpenAI に追加の応答を生成させない。
 */
export const skipResponseOnSuccess = true;
