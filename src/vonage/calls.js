import { buildPublicUrl } from '../config.js';
import { createVonageJwt } from './jwt.js';

const API_BASE = 'https://api.nexmo.com';

/** Vonage API がエラーを返したときに投げるエラー */
export class VonageApiError extends Error {
  constructor(message, { status, body } = {}) {
    super(message);
    this.name = 'VonageApiError';
    this.status = status;
    this.body = body;
  }
}

const request = async (config, method, url, payload) => {
  const response = await fetch(url, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${createVonageJwt(config)}`
    },
    body: JSON.stringify(payload)
  });

  const text = await response.text();
  let body;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { raw: text };
  }

  if (!response.ok) {
    throw new VonageApiError(`Vonage API がエラーを返しました (${response.status})`, {
      status: response.status,
      body
    });
  }

  return body;
};

/**
 * Voice API v2 で発信する。応答すると /answer の NCCO が実行される。
 *
 * @param {object} config
 * @param {{ to: string, from: string }} params
 */
export const createCall = (config, { to, from }) =>
  request(config, 'POST', `${API_BASE}/v2/calls`, {
    to: [{ type: 'phone', number: to }],
    from: { type: 'phone', number: from },
    answer_url: [buildPublicUrl(config, '/answer')],
    answer_method: 'POST',
    event_url: [buildPublicUrl(config, '/event')],
    event_method: 'POST'
  });

/**
 * 通話中のレッグを別の電話番号へ転送する。
 *
 * @param {object} config
 * @param {{ uuid: string, to: string, from: string }} params
 */
export const transferCall = (config, { uuid, to, from }) => {
  if (!uuid) {
    throw new Error('通話 UUID が無いため転送できません。');
  }

  return request(config, 'PUT', `${API_BASE}/v1/calls/${uuid}`, {
    action: 'transfer',
    destination: {
      type: 'ncco',
      ncco: [
        {
          action: 'connect',
          endpoint: [{ type: 'phone', number: to }],
          from
        }
      ]
    }
  });
};
