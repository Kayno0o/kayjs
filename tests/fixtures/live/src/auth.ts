import type { LocalsOf } from 'kay'
import { Elysia } from 'elysia'

export const auth = new Elysia({ name: 'auth' }).derive({ as: 'scoped' }, ({ headers }) => ({ user: headers['x-user'] }))

declare module 'kay' {
  interface Register {
    locals: LocalsOf<typeof auth>
  }
}
