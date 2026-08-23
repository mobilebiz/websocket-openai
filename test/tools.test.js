import tap from 'tap';

import { executeTool, toolDefinitions } from '../src/tools/index.js';
import { testConfig } from './helpers/config.js';

/** 呼び出しを記録するだけのロガー */
const createLog = () => {
  const calls = [];
  const record = (level) => (...args) => calls.push({ level, args });
  return { calls, info: record('info'), warn: record('warn'), error: record('error'), debug: record('debug') };
};

const context = (overrides = {}) => ({
  config: testConfig(),
  callUuid: 'call-uuid-1',
  log: createLog(),
  ...overrides
});

tap.test('toolDefinitions', async (t) => {
  t.equal(toolDefinitions.length, 3);
  for (const definition of toolDefinitions) {
    t.equal(definition.type, 'function', `${definition.name} は function 型`);
    t.ok(definition.description, `${definition.name} に description がある`);
    t.equal(definition.parameters.type, 'object', `${definition.name} の parameters は object`);
  }
});

tap.test('未知のツールでも例外を投げずにエラーを返す', async (t) => {
  const result = await executeTool('no_such_tool', '{}', context());
  t.match(result.output, { error: /未知のツール/ });
  t.notOk(result.skipResponse);
});

tap.test('壊れた JSON 引数を握りつぶす', async (t) => {
  const result = await executeTool('put_name', '{ぐちゃぐちゃ', context());
  t.match(result.output, { error: /引数を解析できませんでした/ });
});

tap.test('put_name', async (t) => {
  await t.test('名前を受け取れば ok', async (t) => {
    const result = await executeTool('put_name', JSON.stringify({ name: '高橋' }), context());
    t.same(result.output, { status: 'ok' });
    t.notOk(result.skipResponse, '応答生成は継続する');
  });

  await t.test('名前が無ければエラーを返す', async (t) => {
    const result = await executeTool('put_name', '{}', context());
    t.match(result.output, { error: /名前を受け取れませんでした/ });
  });
});

tap.test('get_weather はAPIキー未設定を検知する', async (t) => {
  const result = await executeTool(
    'get_weather',
    JSON.stringify({ location: '東京都' }),
    context({ config: testConfig({ OPEN_WEATHER_API_KEY: undefined }) })
  );
  t.match(result.output, { error: /OPEN_WEATHER_API_KEY/ });
});

tap.test('transfer_call', async (t) => {
  await t.test('転送先も既定値も無ければエラー', async (t) => {
    const result = await executeTool(
      'transfer_call',
      '{}',
      context({ config: testConfig({ VONAGE_TRANSPORT_NUMBER: undefined }) })
    );
    t.match(result.output, { error: /VONAGE_TRANSPORT_NUMBER/ });
    t.notOk(result.skipResponse, '失敗時はモデルに伝えるため応答を生成させる');
  });

  await t.test('通話 UUID が無ければエラー', async (t) => {
    const result = await executeTool('transfer_call', '{}', context({ callUuid: '' }));
    t.match(result.output, { error: /UUID/ });
  });

  await t.test('Vonage API の失敗をエラーとして返す', async (t) => {
    // 秘密鍵が無いので JWT 生成で例外になる。executeTool がそれを握ることを確認する
    const result = await executeTool('transfer_call', '{}', context());
    t.match(result.output, { error: /transfer_call の実行に失敗しました/ });
    t.notOk(result.skipResponse);
  });
});
