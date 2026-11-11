import type { PageContext } from '../runtime'
import type { RateLimit } from '../runtime/action-shared'
import { kayLog } from '../runtime/log'
import { chainSetting } from './page-settings'
import { apiLimitWait, checkApiLimit } from './protection'
import { readPersonally } from './scope'
import { Denied } from './signals'

interface PageLimit {
  name: string
  limit: RateLimit
}

type Given = RateLimit | RateLimit[] | false | undefined

const NONE: PageLimit[] = []
// The entries of each limit object by route, kept so a limit's counter is made once and the same one answers every request.
const entries = new WeakMap<object, Map<string, PageLimit[]>>()

// The limits a page counts a request against: its own `rateLimit`, else the innermost layout's, each counted under the route's pattern (the others under their place in the list), so a layout's limit applies to each page under it apart, as its other settings do. `false` lifts what a layout sets.
export function pageLimits(route: { pattern: string }, modules: object[]): PageLimit[] {
  const given = chainSetting(modules, 'rateLimit') as Given

  if (given === undefined || given === false)
    return NONE

  const byRoute = entries.get(given) ?? new Map<string, PageLimit[]>()
  let made = byRoute.get(route.pattern)

  if (!made) {
    made = [given].flat().map((limit, index) => {
      const name = index === 0 ? route.pattern : `${route.pattern}#${index}`

      checkApiLimit(name, limit)

      return { name, limit }
    })
    byRoute.set(route.pattern, made)
    entries.set(given, byRoute)
  }

  return made
}

// The 429 the page answers when its request is over a limit, counting it, else undefined; the guards ran before. It goes out through the nearest `_429.kay` or `_error.kay` with `Retry-After` set, and the page is for this client alone, as its count shows in the answer.
export async function pageOverLimit(route: { pattern: string }, modules: object[], rendering: { ctx: PageContext<Record<string, unknown>>, headers: Headers }): Promise<Denied | undefined> {
  const limits = pageLimits(route, modules)

  if (limits.length === 0)
    return undefined

  const { ctx } = rendering

  readPersonally(ctx.request)

  const wait = await apiLimitWait(limits, ctx.request, undefined, () => ({
    request: ctx.request,
    locale: ctx.locale,
    get cookies() {
      return ctx.cookies
    },
    locals: ctx.locals,
  }))

  if (wait === undefined)
    return undefined

  rendering.headers.set('retry-after', String(wait))

  return new Denied(429, `Too many requests; try again in ${wait} s`)
}

// Why `kay build` does not keep a page nothing marks: it sets `ttl`, which has a stale copy rendered again for every visitor with the request a page reads, which an unmarked page was never asked to, or `rateLimit`, which only the server counts. A marked page is written all the same, with a warning for `rateLimit`: a static host serves the file with no count.
export function keptStop(file: string, revalidate: unknown, chain: object[], auto: boolean, skip: (why: string) => unknown): boolean {
  const given = chainSetting(chain, 'rateLimit')
  const limited = given !== undefined && given !== false

  if (limited && !auto)
    kayLog('warn', `${file} sets \`rateLimit\` and is prerendered: a static host serves the written page with no count, and only the kay server counts the requests it serves`)

  if (!auto || (revalidate === undefined && !limited))
    return false

  skip(revalidate === undefined ? 'sets `rateLimit`, which counts the requests of every visitor' : 'sets `ttl`, which has a stale copy render again for every visitor')

  return true
}
