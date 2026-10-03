import { STATUS_CODES } from 'node:http'

// Thrown by `ctx.redirect()`, `ctx.notFound()` and `ctx.deny()` to end a guard, page or action early; the server turns them into responses.
export class Redirect {
  constructor(readonly location: string, readonly status: number) {}
}

export class NotFound {}

export class Denied {
  readonly message: string

  constructor(readonly status: number, message?: string) {
    this.message = message ?? STATUS_CODES[status] ?? 'Denied'
  }
}
