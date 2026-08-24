import tap from 'tap';

import {
  buildPublicUrl,
  buildWebSocketUrl,
  loadConfig,
  normalizeHost,
  validateConfig
} from '../src/config.js';
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
    'front が自分自身を指していたら設定ミス (front に /media-stream は無い)'
  );

  // SERVER_URL はプロトコル付きも許容するので、素朴な文字列比較だとすり抜ける
  for (const [serverUrl, mediaStreamHost, label] of [
    ['https://vcr.example.com', 'vcr.example.com', 'SERVER_URL だけプロトコル付き'],
    ['vcr.example.com', 'https://vcr.example.com', 'MEDIA_STREAM_HOST だけプロトコル付き'],
    ['vcr.example.com/', 'vcr.example.com', '末尾スラッシュ'],
    ['VCR.example.com', 'vcr.example.com', '大文字小文字']
  ]) {
    t.match(
      validateConfig(frontConfig({ SERVER_URL: serverUrl, MEDIA_STREAM_HOST: mediaStreamHost })),
      [/MEDIA_STREAM_HOST/],
      `表記が違っても同じホストなら弾く: ${label}`
    );
  }

  t.match(validateConfig(testConfig({ SERVER_URL: undefined })), [/SERVER_URL/]);

  // 真値だがホスト名としては空。通すと wss:///media-stream になる
  for (const value of ['   ', 'https://', 'http://', '//']) {
    t.match(
      validateConfig(frontConfig({ MEDIA_STREAM_HOST: value })),
      [/MEDIA_STREAM_HOST/],
      `正規化すると空になる MEDIA_STREAM_HOST を弾く: ${JSON.stringify(value)}`
    );
  }
  t.match(
    validateConfig(testConfig({ MEDIA_STREAM_HOST: '   ' })),
    [/MEDIA_STREAM_HOST/],
    'full でも空のホスト名は弾く'
  );
  t.match(validateConfig(testConfig({ SERVER_URL: '   ' })), [/SERVER_URL/], '空白だけの SERVER_URL も弾く');

  t.match(validateConfig(testConfig({ SERVER_URL: 'http://example.com' })), [/http:\/\//]);
  t.match(
    validateConfig(testConfig({ SERVER_URL: '  HTTP://example.com  ' })),
    [/http:\/\//],
    '大文字や前後の空白があっても http:// を見逃さない'
  );
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

  t.equal(
    buildWebSocketUrl(frontConfig({ MEDIA_STREAM_HOST: 'https://Fly.Example.com/' }), '/media-stream'),
    'wss://fly.example.com/media-stream',
    'プロトコル・末尾スラッシュ・大文字を吸収する'
  );
});

tap.test('normalizeHost', async (t) => {
  for (const [input, expected] of [
    ['https://example.com', 'example.com'],
    ['http://example.com', 'example.com'],
    ['HTTPS://Example.COM/', 'example.com'],
    ['  example.com  ', 'example.com'],
    ['example.com///', 'example.com'],
    ['127.0.0.1:3000', '127.0.0.1:3000'],
    [undefined, ''],
    ['', '']
  ]) {
    t.equal(normalizeHost(input), expected, `${JSON.stringify(input)} -> ${JSON.stringify(expected)}`);
  }
});
