#!/usr/bin/env node

import fetch from 'node-fetch';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import * as fs from 'fs';
import dotenv from 'dotenv';

// ESMで__dirnameを取得するための対応
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// コマンドライン引数の処理
const args = process.argv.slice(2);
const env = args[0] === 'prod' ? 'prod' : 'dev';

// 環境に応じた.envファイルの読み込み
const envFile = env === 'prod' ? '.env.production' : '.env';
console.log(`${env}環境用の${envFile}ファイルを使用します。`);

// .envファイルの存在確認
if (!fs.existsSync(path.resolve(process.cwd(), envFile))) {
  console.error(`エラー: ${envFile}ファイルが見つかりません。`);
  process.exit(1);
}

// .envファイルを読み込む
dotenv.config({ path: envFile });

// 必要な環境変数を取得
const serverUrl = process.env.SERVER_URL;
const applicationId = process.env.VONAGE_APPLICATION_ID;
const apiKey = process.env.VONAGE_API_KEY;
const apiSecret = process.env.VONAGE_API_SECRET;

// 環境変数のチェック
if (!serverUrl) {
  console.error('エラー: 環境変数SERVER_URLが設定されていません。');
  process.exit(1);
}

if (!applicationId) {
  console.error('エラー: 環境変数VONAGE_APPLICATION_IDが設定されていません。');
  process.exit(1);
}

if (!apiKey || !apiSecret) {
  console.error('エラー: Vonage API認証情報（VONAGE_API_KEY, VONAGE_API_SECRET）が設定されていません。');
  process.exit(1);
}

// Webhook URLの設定
const answerUrl = `https://${serverUrl}/answer`;
const eventUrl = `https://${serverUrl}/event`;

console.log(`Vonageアプリケーション(ID: ${applicationId})のWebhook URLを更新します...`);
console.log(`- Answer URL: ${answerUrl} (メソッド: POST)`);
console.log(`- Event URL: ${eventUrl} (メソッド: POST)`);

// Basic認証ヘッダーを作成
function getBasicAuthHeader() {
  const auth = Buffer.from(`${apiKey}:${apiSecret}`).toString('base64');
  return `Basic ${auth}`;
}

// アプリケーションのWebhook URLを更新する関数
async function updateWebhookUrls() {
  try {
    // Basic認証ヘッダーの準備
    const authHeader = {
      'Authorization': getBasicAuthHeader()
    };

    // リクエストボディの作成 - 両方のWebhookでPOSTメソッドを使用
    const requestBody = {
      name: 'websocket-openai',
      capabilities: {
        voice: {
          webhooks: {
            answer_url: {
              address: answerUrl,
              http_method: "POST"  // GETからPOSTに変更
            },
            event_url: {
              address: eventUrl,
              http_method: "POST"  // 既にPOSTだが明示的に指定
            }
          }
        }
      }
    };

    // REST APIリクエスト
    const response = await fetch(`https://api.nexmo.com/v2/applications/${applicationId}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        ...authHeader
      },
      body: JSON.stringify(requestBody)
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`APIエラー (${response.status}): ${errorText}`);
    }

    const result = await response.json();
    console.log('Webhook URLの更新が完了しました。');
    console.log('アプリケーション情報:', JSON.stringify(result, null, 2));
  } catch (error) {
    console.error('Webhook URLの更新に失敗しました:', error);
    process.exit(1);
  }
}

// 更新実行
updateWebhookUrls(); 