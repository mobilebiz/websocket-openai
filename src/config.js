import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// プロジェクトルート (src/ の 1 つ上)
const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const DEFAULT_SYSTEM_MESSAGE = [
  'あなたの名前はチャッピーです。',
  '明るくフレンドリーなAIアシスタントです。',
  'ユーザーが興味を持っている話題について会話し、適切な情報を提供します。',
  'ジョークや楽しい話題を交えながら、常にポジティブでいてください。',
  'なお、会話はすべて日本語で行いますが、ユーザーが言語を指定した場合は、その言語で回答をしてください。',
  'また、会話の最初は「こんにちは。チャッピーです。今日はどのようなお話をしましょうか？」と挨拶をしてください。'
].join('\n');

/**
 * system-message.txt を読み込む。存在しない・空の場合は既定の文言を返す。
 * @param {(message: string) => void} [warn] 警告の出力先
 */
export const loadSystemMessage = (warn = () => {}) => {
  const file = path.join(ROOT_DIR, 'system-message.txt');
  try {
    const content = fs.readFileSync(file, 'utf8').trim();
    if (content) return content;
    warn('system-message.txt が空です。既定のメッセージを使用します。');
  } catch (error) {
    warn(`system-message.txt を読み込めませんでした (${error.message})。既定のメッセージを使用します。`);
  }
  return DEFAULT_SYSTEM_MESSAGE;
};

/**
 * 環境変数から設定オブジェクトを組み立てる。
 * dotenv の読み込みは呼び出し側 (index.js) の責務。
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @param {{ warn?: (message: string) => void }} [options]
 */
export const loadConfig = (env = process.env, { warn = () => {} } = {}) => ({
  rootDir: ROOT_DIR,
  port: Number(env.PORT ?? 3000),
  host: env.HOST ?? '0.0.0.0',
  logLevel: env.LOG_LEVEL ?? (env.NODE_ENV === 'test' ? 'silent' : 'info'),
  // 本番 (Fly.io) では構造化ログのまま、ローカルでは pino-pretty で整形する
  prettyLogs: env.NODE_ENV !== 'production' && env.NODE_ENV !== 'test',

  // ngrok や Fly.io で払い出されるホスト名。プロトコルの有無はどちらでもよい
  serverUrl: env.SERVER_URL ?? '',

  openai: {
    apiKey: env.OPENAI_API_KEY ?? '',
    model: env.OPENAI_MODEL ?? 'gpt-realtime',
    voice: env.OPENAI_VOICE ?? 'alloy',
    transcriptionModel: env.OPENAI_TRANSCRIPTION_MODEL ?? 'gpt-4o-transcribe'
  },

  vonage: {
    applicationId: env.VONAGE_APPLICATION_ID ?? '',
    outboundFrom: env.VONAGE_OUTBOUND_FROM ?? '',
    // 転送先の既定値。transfer_call で指定がない場合に使う
    transferTo: env.VONAGE_TRANSPORT_NUMBER ?? '',
    privateKey: env.VONAGE_PRIVATE_KEY ?? '',
    privateKeyPath: env.VONAGE_PRIVATE_KEY_PATH ?? ''
  },

  // /connect を叩くための共有シークレット。
  // 未設定なら従来どおりアプリケーション ID にフォールバックする (後方互換)
  connectApiKey: env.CONNECT_API_KEY ?? env.VONAGE_APPLICATION_ID ?? '',
  connectApiKeyIsFallback: !env.CONNECT_API_KEY && Boolean(env.VONAGE_APPLICATION_ID),

  openWeatherApiKey: env.OPEN_WEATHER_API_KEY ?? '',

  systemMessage: loadSystemMessage(warn)
});

/**
 * 起動を止めるべき設定不足を列挙する。
 * @param {ReturnType<typeof loadConfig>} config
 * @returns {string[]} 問題点のリスト (空なら問題なし)
 */
export const validateConfig = (config) => {
  const problems = [];
  if (!config.openai.apiKey) problems.push('OPENAI_API_KEY が設定されていません。');
  if (!config.openai.model) problems.push('OPENAI_MODEL が設定されていません。');
  if (!config.serverUrl) {
    problems.push('SERVER_URL が設定されていません。');
  } else if (config.serverUrl.startsWith('http://')) {
    // Vonage の NCCO で指定できる WebSocket は wss:// のみなので、
    // ws:// を組み立てても接続できない。設定ミスとして弾く
    problems.push('SERVER_URL に http:// は指定できません。https のホスト名を指定してください。');
  }
  return problems;
};

/**
 * SERVER_URL から公開 URL を組み立てる。
 * @param {ReturnType<typeof loadConfig>} config
 * @param {string} [pathname]
 */
export const buildPublicUrl = (config, pathname = '') => {
  const { serverUrl } = config;
  if (!serverUrl) return '';
  const hasProtocol = serverUrl.startsWith('http://') || serverUrl.startsWith('https://');
  return `${hasProtocol ? serverUrl : `https://${serverUrl}`}${pathname}`;
};

/**
 * SERVER_URL から WebSocket URL を組み立てる。
 * @param {ReturnType<typeof loadConfig>} config
 * @param {string} pathname
 * @param {Record<string, string>} [query]
 */
export const buildWebSocketUrl = (config, pathname, query = {}) => {
  const host = config.serverUrl.replace(/^https?:\/\//, '');
  const search = new URLSearchParams(query).toString();
  return `wss://${host}${pathname}${search ? `?${search}` : ''}`;
};
