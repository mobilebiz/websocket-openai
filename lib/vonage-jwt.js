import jwt from 'jsonwebtoken';
import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';

let vonagePrivateKey = null;

const resolveVonagePrivateKey = () => {
  const { VONAGE_PRIVATE_KEY, VONAGE_PRIVATE_KEY_PATH } = process.env;

  if (VONAGE_PRIVATE_KEY && VONAGE_PRIVATE_KEY.trim()) {
    return VONAGE_PRIVATE_KEY.trim();
  }

  if (!VONAGE_PRIVATE_KEY_PATH) {
    return null;
  }

  const resolvedPath = path.isAbsolute(VONAGE_PRIVATE_KEY_PATH)
    ? VONAGE_PRIVATE_KEY_PATH
    : path.resolve(process.cwd(), VONAGE_PRIVATE_KEY_PATH);
  try {
    return fs.readFileSync(resolvedPath, 'utf8').trim();
  } catch (error) {
    console.warn(`Vonageのプライベートキーを ${resolvedPath} から読み込めませんでした: ${error.message}`);
    return null;
  }
};

export const createVonageJwt = () => {
  const { VONAGE_APPLICATION_ID } = process.env;

  if (!vonagePrivateKey) {
    vonagePrivateKey = resolveVonagePrivateKey();
  }

  if (!VONAGE_APPLICATION_ID || !vonagePrivateKey) {
    throw new Error('VonageのアプリケーションIDまたはプライベートキーが設定されていません。');
  }
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    application_id: VONAGE_APPLICATION_ID,
    iat: now,
    exp: now + 60 * 5,
    jti: randomUUID()
  };

  return jwt.sign(payload, vonagePrivateKey, { algorithm: 'RS256' });
};
