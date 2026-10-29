import type { LocalsOf } from 'kay'
import { memorySessions, session } from 'kay/server'

export const sessions = session<{ user: string }>({ secret: 'a test secret that is long enough to seal', store: memorySessions() })

declare module 'kay' {
  interface Register {
    locals: LocalsOf<typeof sessions>
  }
}
