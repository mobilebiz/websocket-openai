export const definition = {
  type: 'function',
  name: 'put_name',
  description: '取得したユーザー名を記録します',
  parameters: {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        description: 'ユーザーの名前'
      }
    },
    required: ['name']
  }
};

/**
 * ユーザー名を記録する。現状はログ出力のみ。
 * @param {{ name: string }} args
 * @param {{ log: import('fastify').FastifyBaseLogger }} context
 */
export const handler = async ({ name }, { log }) => {
  if (!name || typeof name !== 'string') {
    log.warn({ name }, 'put_name: 名前を正しく受け取れませんでした');
    return { error: '名前を受け取れませんでした。' };
  }

  log.info({ name }, '🧑 ユーザー名を記録しました');
  return { status: 'ok' };
};
