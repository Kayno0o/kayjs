import type { RequestContext } from '@kayjs/kay/server'

export function GET(ctx: RequestContext) {
  return ctx.json({ ok: true, runtime: 'bun' })
}
