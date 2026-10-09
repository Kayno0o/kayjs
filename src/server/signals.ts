import { nodeHttp } from './builtins'

// Thrown by `ctx.redirect()`, `ctx.notFound()` and `ctx.deny()` to end a guard, page or action early; the server turns them into responses.
// A line break would split the `location` header, and Bun refuses any control character there with its own message.
// eslint-disable-next-line no-control-regex -- control characters are what it finds
const CONTROL = /[\0-\x1F\x7F]/
// A scheme other than http(s), such as `javascript:`, which an island's call would hand to `location.assign`.
const OTHER_SCHEME = /^(?!https?:)[a-z][a-z\d+.-]*:/i
// A header holds bytes, so a location such as `/blog/日本語` goes out percent-encoded, as a browser would request it.
const NON_ASCII = /[^\0-\x7F]+/g

export class Redirect {
  readonly location: string

  constructor(location: string, readonly status: number) {
    if (CONTROL.test(location))
      throw new TypeError(`kay: the redirect to ${JSON.stringify(location)} holds a line break or another control character`)

    if (OTHER_SCHEME.test(location.trimStart()))
      throw new TypeError(`kay: a redirect goes to a path or an http(s) URL, not to ${JSON.stringify(location)}`)

    this.location = location.toWellFormed().replace(NON_ASCII, encodeURI)
  }
}

export class NotFound {}

export class Denied {
  readonly message: string

  constructor(readonly status: number, message?: string) {
    this.message = message ?? nodeHttp().STATUS_CODES[status] ?? 'Denied'
  }
}
