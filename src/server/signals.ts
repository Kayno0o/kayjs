import { STATUS_CODES } from 'node:http'

// Thrown by `ctx.redirect()`, `ctx.notFound()` and `ctx.deny()` to end a guard, page or action early; the server turns them into responses.
// A line break would split the `location` header, which Bun refuses with its own message.
const LINE_BREAK = /[\r\n]/
// A header holds bytes, so a location such as `/blog/日本語` goes out percent-encoded, as a browser would request it.
const NON_ASCII = /[^\0-\x7F]+/g

export class Redirect {
  readonly location: string

  constructor(location: string, readonly status: number) {
    if (LINE_BREAK.test(location))
      throw new TypeError(`kay: the redirect to ${JSON.stringify(location)} holds a line break`)

    this.location = location.toWellFormed().replace(NON_ASCII, encodeURI)
  }
}

export class NotFound {}

export class Denied {
  readonly message: string

  constructor(readonly status: number, message?: string) {
    this.message = message ?? STATUS_CODES[status] ?? 'Denied'
  }
}
