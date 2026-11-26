// Request parsing and client-address helpers shared by the auth routes.

import type { RequestContext, TrustProxy } from '@kayjs/kay/server'
import { getClientIp } from '@kayjs/kay/server'

export function wantsJson(req: Request): boolean {
  const accept = req.headers.get('accept') ?? ''
  const ct = req.headers.get('content-type') ?? ''
  return accept.includes('application/json') || ct.includes('application/json')
}

async function readBody(req: Request): Promise<Record<string, string>> {
  const ct = req.headers.get('content-type') ?? ''
  if (ct.includes('application/json')) {
    const raw = await req.json() as Record<string, unknown>
    const out: Record<string, string> = {}
    for (const [k, v] of Object.entries(raw ?? {})) {
      if (typeof v === 'string')
        out[k] = v
    }
    return out
  }
  if (ct.includes('application/x-www-form-urlencoded') || ct.includes('multipart/form-data')) {
    const fd = await req.formData()
    const out: Record<string, string> = {}
    for (const [k, v] of fd.entries()) {
      if (typeof v === 'string')
        out[k] = v
    }
    return out
  }
  return {}
}

export function fail(ctx: RequestContext, status: number, error: string): Response {
  return ctx.json({ ok: false, error }, { status })
}

export function respondAuthError(ctx: RequestContext, status: number, error: string, redirectTo?: string): Response {
  if (wantsJson(ctx.request) || !redirectTo)
    return ctx.json({ ok: false, error }, { status })
  const sep = redirectTo.includes('?') ? '&' : '?'
  return ctx.redirect(`${redirectTo}${sep}error=${encodeURIComponent(error)}`, 303)
}

const ATTR_SPECIALS_RE = /[&"<>]/g
const ATTR_ENTITIES: Record<string, string> = { '&': '&amp;', '"': '&quot;', '<': '&lt;', '>': '&gt;' }

/** The page a mailed link opens: one button posting the token back, so a mail scanner's GET leaves the link unused. No script or style, so any CSP lets it through. */
export function linkConfirmPage(copy: { title: string, button: string }, fields: Record<string, string>): Response {
  let inputs = ''
  for (const [name, value] of Object.entries(fields))
    inputs += `<input type="hidden" name="${name}" value="${value.replace(ATTR_SPECIALS_RE, c => ATTR_ENTITIES[c]!)}">`
  const html = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><meta name="referrer" content="no-referrer"><title>${copy.title}</title></head><body><main><h1>${copy.title}</h1><form method="post">${inputs}<button type="submit">${copy.button}</button></form></main></body></html>`
  return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } })
}

export function withNoStore(res: Response): Response {
  if (res.headers.has('cache-control'))
    return res
  try {
    res.headers.set('cache-control', 'no-store')
    return res
  }
  catch {
    const headers = new Headers(res.headers)
    headers.set('cache-control', 'no-store')
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers })
  }
}

export async function parseBody(ctx: RequestContext): Promise<Record<string, string> | Response> {
  try {
    return await readBody(ctx.request)
  }
  catch {
    return fail(ctx, 400, 'Invalid request body')
  }
}

export function isValidEmail(email: string): boolean {
  const e = email.trim()
  const at = e.indexOf('@')
  return at > 0 && at === e.lastIndexOf('@') && e.indexOf('.', at + 2) > at + 1 && !/\s/.test(e)
}

export function resolveClientIp(ctx: RequestContext, trustProxy: TrustProxy): string {
  return ctx.ip?.trim() || getClientIp(ctx.request, trustProxy) || 'unknown'
}

export function formatSessionIp(ip: string, mode: boolean | 'truncate'): string | undefined {
  if (mode === false || ip === 'unknown')
    return undefined
  if (mode === true)
    return ip
  // Truncate mode: IPv4 -> /24, IPv4-mapped IPv6 -> /120, IPv6 -> /48
  const v4 = /^(\d{1,3}\.\d{1,3}\.\d{1,3})\.\d{1,3}$/.exec(ip)
  if (v4)
    return `${v4[1]}.0`
  const v4Mapped = /^(::ffff:\d{1,3}\.\d{1,3}\.\d{1,3})\.\d{1,3}$/i.exec(ip)
  if (v4Mapped)
    return `${v4Mapped[1]}.0`
  if (ip.includes(':')) {
    const [head = '', tail = ''] = ip.split('::')
    const headParts = head ? head.split(':').filter(Boolean) : []
    const tailParts = ip.includes('::') && tail ? tail.split(':').filter(Boolean) : []
    const full = ip.includes('::')
      ? [...headParts, ...Array.from({ length: Math.max(0, 8 - headParts.length - tailParts.length) }, () => '0'), ...tailParts]
      : headParts
    if (full.length >= 3)
      return `${full.slice(0, 3).join(':')}::`
  }
  return undefined
}
