import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  registerAppTool,
  registerAppResource,
  RESOURCE_MIME_TYPE
} from '@modelcontextprotocol/ext-apps/server';
import { z } from 'zod';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FASTIFY_PORT = process.env.VCR_PORT || process.env.PORT || 3000;
const FASTIFY_URL = process.env.FASTIFY_URL || `http://localhost:${FASTIFY_PORT}`;
const VONAGE_APPLICATION_ID = process.env.VONAGE_APPLICATION_ID;

const server = new McpServer({
  name: 'vonage-reception',
  version: '1.0.0',
});

// ── ユーティリティ ─────────────────────────────────

function readUiHtml(filename) {
  return fs.readFileSync(path.join(__dirname, 'src', 'ui', filename), 'utf-8');
}

async function fetchCalls() {
  try {
    const res = await fetch(`${FASTIFY_URL}/api/calls`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (err) {
    return { error: `Fastify サーバーに接続できません (${FASTIFY_URL}): ${err.message}` };
  }
}

// ── ツール1: 受付モニター ───────────────────────────

const callMonitorUri = 'ui://vonage-reception/call-monitor.html';

registerAppTool(server, 'monitor-calls', {
  title: '受付モニター',
  description:
    '現在の着信・通話状況をリアルタイムダッシュボードで確認します。中小企業の電話受付をAIがサポートし、必要に応じて人間に転送できます。',
  inputSchema: {},
  _meta: { ui: { resourceUri: callMonitorUri } },
}, async () => {
  const calls = await fetchCalls();
  if (calls.error) {
    return { content: [{ type: 'text', text: calls.error }] };
  }
  const active = calls.filter(c => c.status === 'active').length;
  const total = calls.length;
  return {
    content: [{ type: 'text', text: `通話状況: アクティブ ${active} 件 / 合計 ${total} 件` }],
    structuredContent: { calls, serverUrl: FASTIFY_URL },
  };
});

registerAppResource(
  server,
  '受付モニター',
  callMonitorUri,
  { description: '通話監視ダッシュボード' },
  async () => ({
    contents: [{
      uri: callMonitorUri,
      mimeType: RESOURCE_MIME_TYPE,
      text: readUiHtml('call-monitor.html'),
    }],
  })
);

// app-only: UIからの通話リスト更新用（モデルには見えない）
registerAppTool(server, 'refresh-calls', {
  description: '通話リストを最新に更新します',
  inputSchema: {},
  _meta: { ui: { resourceUri: callMonitorUri, visibility: ['app'] } },
}, async () => {
  const calls = await fetchCalls();
  return {
    content: [{ type: 'text', text: JSON.stringify(calls) }],
    structuredContent: { calls },
  };
});

// ── ツール2: 発信パネル ─────────────────────────────

const outboundCallUri = 'ui://vonage-reception/outbound-call.html';

registerAppTool(server, 'make-call', {
  title: '電話発信',
  description:
    '指定した電話番号に Vonage Voice API で発信します。発信パネルUIで状態を確認できます。',
  inputSchema: {
    to: z.string().describe('発信先の電話番号 (E.164形式, 例: +819012345678)'),
    from: z.string().optional().describe('発信元の電話番号 (省略時はデフォルト)'),
  },
  _meta: { ui: { resourceUri: outboundCallUri } },
}, async ({ to, from }) => {
  try {
    const res = await fetch(`${FASTIFY_URL}/connect`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': VONAGE_APPLICATION_ID || '',
      },
      body: JSON.stringify({ to, from }),
    });
    const body = await res.json();

    if (!res.ok) {
      return {
        content: [{ type: 'text', text: `発信失敗: ${body.error || res.statusText}` }],
        structuredContent: { error: body.error, status: res.status },
      };
    }

    return {
      content: [{ type: 'text', text: `${to} への発信を開始しました (UUID: ${body.uuid})` }],
      structuredContent: { ...body, to, from, status: 'initiated' },
    };
  } catch (err) {
    return {
      content: [{ type: 'text', text: `発信エラー: ${err.message}` }],
      structuredContent: { error: err.message },
    };
  }
});

registerAppResource(
  server,
  '発信パネル',
  outboundCallUri,
  { description: '電話発信コントロールパネル' },
  async () => ({
    contents: [{
      uri: outboundCallUri,
      mimeType: RESOURCE_MIME_TYPE,
      text: readUiHtml('outbound-call.html'),
    }],
  })
);

// ── ツール3: 通話転送 ───────────────────────────────

const transferDialogUri = 'ui://vonage-reception/transfer-dialog.html';

registerAppTool(server, 'transfer-call', {
  title: '通話転送',
  description:
    '進行中の通話を別の電話番号（人間のオペレーター等）に転送します。転送確認UIが表示されます。',
  inputSchema: {
    uuid: z.string().describe('転送する通話の UUID'),
    destination: z.string().optional().describe('転送先の電話番号 (E.164形式)'),
  },
  _meta: { ui: { resourceUri: transferDialogUri } },
}, async ({ uuid, destination }) => {
  // 転送先は引数 > 環境変数 の優先順
  const transferTo = destination || process.env.VONAGE_TRANSPORT_NUMBER;
  if (!transferTo) {
    return {
      content: [{ type: 'text', text: '転送先が指定されていません。' }],
      structuredContent: { error: '転送先が未指定です', uuid },
    };
  }

  // 通話情報を取得
  let callInfo = null;
  try {
    const res = await fetch(`${FASTIFY_URL}/api/calls/${uuid}`);
    if (res.ok) callInfo = await res.json();
  } catch { /* ignore */ }

  return {
    content: [{ type: 'text', text: `通話 ${uuid} を ${transferTo} に転送する準備ができました。` }],
    structuredContent: {
      uuid,
      destination: transferTo,
      callInfo,
      status: 'pending_confirmation',
    },
  };
});

registerAppResource(
  server,
  '通話転送ダイアログ',
  transferDialogUri,
  { description: '通話転送の確認ダイアログ' },
  async () => ({
    contents: [{
      uri: transferDialogUri,
      mimeType: RESOURCE_MIME_TYPE,
      text: readUiHtml('transfer-dialog.html'),
    }],
  })
);

// app-only: UIからの転送実行用
registerAppTool(server, 'execute-transfer', {
  description: '通話転送を実行します',
  inputSchema: {
    uuid: z.string(),
    destination: z.string(),
  },
  _meta: { ui: { resourceUri: transferDialogUri, visibility: ['app'] } },
}, async ({ uuid, destination }) => {
  try {
    // transfer-call.js の機能を HTTP 経由ではなく、
    // Fastify サーバーの内部 API を使って転送を実行
    // （プロトタイプでは /api/calls から状態を確認）
    const { transferCall } = await import('./transfer-call.js');
    const { createVonageJwt } = await import('./lib/vonage-jwt.js');

    await transferCall(uuid, destination, process.env.VONAGE_OUTBOUND_FROM);

    return {
      content: [{ type: 'text', text: `転送完了: ${uuid} → ${destination}` }],
      structuredContent: { uuid, destination, status: 'transferred' },
    };
  } catch (err) {
    return {
      content: [{ type: 'text', text: `転送失敗: ${err.message}` }],
      structuredContent: { error: err.message, uuid, destination },
    };
  }
});

// ── サーバー起動 ─────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
