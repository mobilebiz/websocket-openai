import dotenv from 'dotenv';

import { loadConfig, validateConfig } from './src/config.js';
import { buildServer } from './src/server.js';

// Vonage Voice の音声ストリームを受け取り、OpenAI Realtime API へ中継するサーバー
dotenv.config({ quiet: true });

const config = loadConfig(process.env, { warn: (message) => console.warn(message) });

const problems = validateConfig(config);
if (problems.length > 0) {
  console.error('環境変数が不足しています。 .env ファイルで設定してください。');
  for (const problem of problems) console.error(`- ${problem}`);
  process.exit(1);
}

const fastify = buildServer(config);

try {
  await fastify.listen({ port: config.port, host: config.host });
  fastify.log.info(
    { role: config.appRole, mediaStreamHost: config.mediaStreamHost },
    config.appRole === 'front'
      ? 'front として起動しました (NCCO を返すのみ)'
      : 'full として起動しました'
  );
} catch (error) {
  fastify.log.error({ err: error }, 'サーバーの起動に失敗しました');
  process.exit(1);
}
