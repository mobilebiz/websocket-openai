import { loadConfig } from '../../src/config.js';

/** テスト用の環境変数一式。実行環境の .env に依存しないよう明示的に与える */
export const TEST_ENV = {
  NODE_ENV: 'test',
  SERVER_URL: 'example.com',
  OPENAI_API_KEY: 'sk-test',
  OPENAI_MODEL: 'gpt-realtime',
  VONAGE_APPLICATION_ID: 'test-application-id',
  VONAGE_OUTBOUND_FROM: '+815012345678',
  VONAGE_TRANSPORT_NUMBER: '+818098765432',
  OPEN_WEATHER_API_KEY: 'test-weather-key'
};

/** @param {Record<string, string>} [overrides] */
export const testConfig = (overrides = {}) => loadConfig({ ...TEST_ENV, ...overrides });

/** VCR に置く前段 (APP_ROLE=front) の設定 */
export const frontConfig = (overrides = {}) =>
  testConfig({
    APP_ROLE: 'front',
    SERVER_URL: 'vcr.example.com',
    MEDIA_STREAM_HOST: 'fly.example.com',
    OPENAI_API_KEY: undefined,
    OPENAI_MODEL: undefined,
    ...overrides
  });
