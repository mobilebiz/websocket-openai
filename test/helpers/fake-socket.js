import { EventEmitter } from 'node:events';

/** ws.WebSocket の最小の代替。送信内容を記録し、任意のイベントを流し込める */
export class FakeSocket extends EventEmitter {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  /** 直近に生成されたインスタンス (bridge が内部で new するため) */
  static last = null;

  readyState = FakeSocket.OPEN;
  sent = [];
  url = null;
  options = null;

  constructor(url, options) {
    super();
    this.url = url ?? null;
    this.options = options ?? null;
    FakeSocket.last = this;
  }

  send(payload) {
    this.sent.push(payload);
  }

  close() {
    this.readyState = FakeSocket.CLOSED;
    this.emit('close', 1000, Buffer.from(''));
  }

  /** JSON として送られたメッセージだけを取り出す */
  sentJson() {
    return this.sent
      .filter((payload) => typeof payload === 'string')
      .map((payload) => JSON.parse(payload));
  }

  /** バイナリで送られたメッセージだけを取り出す */
  sentBinary() {
    return this.sent.filter(Buffer.isBuffer);
  }

  /** サーバーからのメッセージを模擬する */
  receive(event) {
    this.emit('message', Buffer.from(JSON.stringify(event)), false);
  }
}

/** 何もしないロガー */
export const silentLog = {
  info() {},
  warn() {},
  error() {},
  debug() {},
  child() {
    return silentLog;
  }
};
