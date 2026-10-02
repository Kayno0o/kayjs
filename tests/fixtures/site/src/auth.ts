import type { LocalsOf } from 'kay'
import { Elysia } from 'elysia'

// What the app derives for every request, pages and actions included.
export const auth = new Elysia({ name: 'auth' }).derive({ as: 'scoped' }, ({ headers }) => ({ user: headers['x-user'] }))

declare module 'kay' {
  interface Register {
    locals: LocalsOf<typeof auth>
  }
}
