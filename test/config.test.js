import tap from 'tap';

import { buildPublicUrl, buildWebSocketUrl, loadConfig, validateConfig } from '../src/config.js';
import { frontConfig, testConfig } from './helpers/config.js';

tap.test('APP_ROLE', async (t) => {
  t.equal(testConfig().appRole, 'full', '既定は full');
  t.equal(frontConfig().appRole, 'front');
  t.equal(testConfig({ APP_ROLE: 'なにか' }).appRole, 'full', '未知の値は full に丸める');
});

tap.test('ポートは VCR_PORT を優先する', async (t) => {
  t.equal(loadConfig({ VCR_PORT: '5001', PORT: '4000' }).port, 5001, 'VCR 上では VCR_PORT に従う');
  t.equal(loadConfig({ PORT: '4000' }).port, 4000);
  t.equal(loadConfig({}).port, 3000, '既定は 3000');
});

tap.test('mediaStreamHost', async (t) => {
  t.equal(testConfig().mediaStreamHost, 'example.com', 'full では自分自身');
  t.equal(frontConfig().mediaStreamHost, 'fly.example.com', 'front では本体を指す');
});

tap.test('validateConfig', async (t) => {
  t.same(validateConfig(testConfig()), [], 'full の既定値は問題なし');
  t.same(validateConfig(frontConfig()), [], 'front は OpenAI の設定が無くても起動できる');

  t.match(
    validateConfig(testConfig({ OPENAI_API_KEY: undefined })),
    [/OPENAI_API_KEY/],
    'full では OpenAI のキーが要る'
  );

  t.match(
    validateConfig(frontConfig({ MEDIA_STREAM_HOST: undefined })),
    [/MEDIA_STREAM_HOST/],
    'front で本体のホストが無いのは設定ミス'
  );

  t.match(
    validateConfig(frontConfig({ MEDIA_STREAM_HOST: 'vcr.example.com' })),
    [/MEDIA_STREAM_HOST/],
    'front が自分自身を指していたら設定ミス (無限に自分へ繋ぎにいく)'
  );

  t.match(validateConfig(testConfig({ SERVER_URL: undefined })), [/SERVER_URL/]);
  t.match(validateConfig(testConfig({ SERVER_URL: 'http://example.com' })), [/http:\/\//]);
});

tap.test('URL の組み立て', async (t) => {
  const config = testConfig();
  t.equal(buildPublicUrl(config, '/answer'), 'https://example.com/answer');
  t.equal(
    buildPublicUrl(testConfig({ SERVER_URL: 'https://example.com' }), '/answer'),
    'https://example.com/answer',
    'プロトコル付きでも二重にならない'
  );

  t.equal(
    buildWebSocketUrl(frontConfig(), '/media-stream', { a: '1' }),
    'wss://fly.example.com/media-stream?a=1'
  );
  t.equal(buildWebSocketUrl(config, '/media-stream'), 'wss://example.com/media-stream', 'クエリなし');
});
