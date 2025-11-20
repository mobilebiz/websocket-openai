import fetch from 'node-fetch';
import { createVonageJwt } from './lib/vonage-jwt.js';

/**
 * 指定された通話を別の電話番号に転送します。
 * 
 * @param {string} uuid - 転送する通話のUUID (Vonage Call UUID)
 * @param {string} destination - 転送先の電話番号 (E.164形式)
 * @param {string} fromNumber - 転送時の発信者番号として表示する番号 (通常は元の着信番号)
 * @returns {Promise<boolean>} 転送リクエストが成功した場合は true
 * @throws {Error} UUIDがない場合、または転送リクエストが失敗した場合
 */
export const transferCall = async (uuid, destination, fromNumber) => {
  if (!uuid) {
    throw new Error('UUIDがないため転送できません');
  }

  const jwtToken = createVonageJwt();
  const transferPayload = {
    action: 'transfer',
    destination: {
      type: 'ncco',
      ncco: [
        {
          action: 'connect',
          endpoint: [{ type: 'phone', number: destination }],
          from: fromNumber
        }
      ]
    }
  };

  const response = await fetch(`https://api.nexmo.com/v1/calls/${uuid}`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${jwtToken}`
    },
    body: JSON.stringify(transferPayload)
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Transfer failed: ${response.statusText} - ${errorText}`);
  }

  return true;
};
