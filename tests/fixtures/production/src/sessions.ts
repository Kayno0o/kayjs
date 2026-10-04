import type { LocalsOf } from 'kay'
import { memoryStore, session } from 'kay/server'

export const sessions = session<{ user: string }>({ secret: 'a test secret that is long enough to seal', store: memoryStore() })

declare module 'kay' {
  interface Register {
    locals: LocalsOf<typeof sessions>
  }
}
