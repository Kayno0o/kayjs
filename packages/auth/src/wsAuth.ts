export interface WsSender {
  send: (msg: string) => void
  close: () => void
}

export interface Ws extends WsSender {
  id: string | number
}

/** Shared WS auth handshake: verifies the token, tracks the authed value per connection, replies `{type:'authed'}`; `verify` returns null to reject. */
export function createWsAuthStore<T>(verify: (token: string, ws: Ws) => Promise<T | null> | T | null) {
  const authed = new Map<string, T>()

  return {
    async handleAuth(ws: Ws, token: string): Promise<void> {
      const value = await verify(token, ws)

      if (value === null || value === undefined)
        return

      authed.set(String(ws.id), value)
      ws.send(JSON.stringify({ type: 'authed' }))
    },
    get: (ws: Ws): T | undefined => authed.get(String(ws.id)),
    forget: (ws: Ws) => authed.delete(String(ws.id)),
  }
}
