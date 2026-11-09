// Bun's `WebSocket` client as server code types it: a project's tsconfig loads the DOM lib, whose constructor takes no options, so `new WebSocket(url, { headers })` is a type error there while Bun runs it.
export interface ServerWebSocketClient {
  prototype: WebSocket
  new (url: string | URL, options?: Bun.WebSocketOptions): WebSocket
  readonly CONNECTING: 0
  readonly OPEN: 1
  readonly CLOSING: 2
  readonly CLOSED: 3
}

export const ServerWebSocket: ServerWebSocketClient = WebSocket as unknown as ServerWebSocketClient
