// Thrown by `ctx.redirect()` and `ctx.notFound()` to end a page or action early; the server turns them into responses.
export class Redirect {
  constructor(readonly location: string, readonly status: number) {}
}

export class NotFound {}
