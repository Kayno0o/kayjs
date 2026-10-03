import { STATUS_CODES } from 'node:http'

// Thrown by `ctx.redirect()`, `ctx.notFound()` and `ctx.deny()` to end a guard, page or action early; the server turns them into responses.
// A line break would split the `location` header, which Bun refuses with its own message.
const LINE_BREAK = /[\r\n]/

export class Redirect {
  constructor(readonly location: string, readonly status: number) {
    if (LINE_BREAK.test(location))
      throw new TypeError(`kay: the redirect to ${JSON.stringify(location)} holds a line break`)
  }
}

export class NotFound {}

export class Denied {
  readonly message: string

  constructor(readonly status: number, message?: string) {
    this.message = message ?? STATUS_CODES[status] ?? 'Denied'
  }
}
