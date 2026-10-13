export interface WsSender {
  send: (msg: string) => void
  close: () => void
}

export interface Ws extends WsSender {
  id: string | number
}

// How long a verified token stays good before `get` checks it again, so a revoked token or a banned user loses the socket.
const VERIFIED_FRESH_MS = 30 * 1000

/** Shared WS auth handshake: verifies the token, tracks the authed value per connection, replies `{type:'authed'}`; `verify` returns null to reject. `get` verifies the token again past 30 seconds, and closes the socket once it is refused. */
export function createWsAuthStore<T>(verify: (token: string, ws: Ws) => Promise<T | null> | T | null) {
  const authed = new Map<string, { token: string, value: T, at: number }>()

  return {
    async handleAuth(ws: Ws, token: string): Promise<void> {
      const value = await verify(token, ws)

      if (value === null || value === undefined)
        return

      authed.set(String(ws.id), { token, value, at: Date.now() })
      ws.send(JSON.stringify({ type: 'authed' }))
    },
    async get(ws: Ws): Promise<T | undefined> {
      const id = String(ws.id)
      const entry = authed.get(id)

      if (!entry || Date.now() - entry.at <= VERIFIED_FRESH_MS)
        return entry?.value

      const value = await verify(entry.token, ws)

      // Forgotten meanwhile, as by the socket closing.
      if (authed.get(id) !== entry)
        return authed.get(id)?.value

      if (value === null || value === undefined) {
        authed.delete(id)
        ws.close()

        return undefined
      }

      authed.set(id, { token: entry.token, value, at: Date.now() })

      return value
    },
    forget: (ws: Ws) => authed.delete(String(ws.id)),
  }
}
