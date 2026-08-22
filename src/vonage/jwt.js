import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import jwt from 'jsonwebtoken';

const cache = new WeakMap();

/**
 * 秘密鍵を解決する。VONAGE_PRIVATE_KEY (本番: Fly secrets) を優先し、
 * 無ければ VONAGE_PRIVATE_KEY_PATH のファイルを読む (ローカル開発)。
 * @param {import('../config.js').loadConfig extends (...a: any) => infer C ? C : never} config
 */
const resolvePrivateKey = (config) => {
  const { privateKey, privateKeyPath } = config.vonage;

  if (privateKey.trim()) return privateKey.trim();
  if (!privateKeyPath) return null;

  const resolved = path.isAbsolute(privateKeyPath)
    ? privateKeyPath
    : path.resolve(config.rootDir, privateKeyPath);

  try {
    return fs.readFileSync(resolved, 'utf8').trim();
  } catch (error) {
    throw new Error(`Vonage の秘密鍵を ${resolved} から読み込めませんでした: ${error.message}`);
  }
};

/**
 * Vonage Voice API 用の JWT を生成する。
 * 秘密鍵は config ごとに一度だけ読み込んでキャッシュする。
 *
 * @param {object} config loadConfig() の戻り値
 * @returns {string} RS256 で署名した JWT
 */
export const createVonageJwt = (config) => {
  const { applicationId } = config.vonage;

  if (!cache.has(config)) {
    cache.set(config, resolvePrivateKey(config));
  }
  const key = cache.get(config);

  if (!applicationId || !key) {
    throw new Error('Vonage のアプリケーション ID または秘密鍵が設定されていません。');
  }

  const now = Math.floor(Date.now() / 1000);
  return jwt.sign(
    {
      application_id: applicationId,
      iat: now,
      exp: now + 60 * 5,
      jti: randomUUID()
    },
    key,
    { algorithm: 'RS256' }
  );
};
