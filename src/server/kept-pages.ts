import type { Elysia } from 'elysia'
import type { ServedPage } from './render'
import { kayLog } from '../runtime/log'
import { withPageToken } from '../runtime/uid.server'
import { pathOf, statusOf } from './log'
import { ownPostPaths } from './plumbing'
import { pageEtag, pageToken } from './prerendered'

// How many requests that can write have started or ended without a refusal, which a kept page is checked against.
export interface Writes {
  readonly count: number
}

// What kay answers itself without changing what a page renders, taken from the list of its own endpoints: the beats, reports and drafts the browser posts.
const KAY_ROUTES = ownPostPaths()
const SLASH = 47
// The answers of a request turned away before a handler wrote anything: a cross-site post, a limit, a body or a field that does not pass. A handler answering one after a write is rare enough to take for the same.
const REFUSED = new Set([400, 401, 403, 405, 413, 415, 422, 429])

// The status of an answer: a `status()` a handler returned carries its code, which `set` only gets once the response is made.
function answeredWith(responseValue: unknown, set: { status?: unknown }): number {
  const code = typeof responseValue === 'object' && responseValue !== null && 'code' in responseValue ? responseValue.code : undefined

  return typeof code === 'number' ? code : statusOf(responseValue, set)
}

// A path without its trailing slashes, found by a scan rather than a pattern, as a hostile path may be mostly slashes.
function withoutTrailingSlashes(path: string): string {
  let end = path.length

  while (end > 1 && path.charCodeAt(end - 1) === SLASH)
    end--

  return path.slice(0, end)
}

// A request that is not a GET, a HEAD or an OPTIONS can change what a page renders, an action as much as a route of the app, once a route answers it: one to no route, and kay's own routes in `own` (the MCP endpoint among them, whose tool calls reach the app's actions and count there), write nothing, so no visitor can force a page to render again by sending them.
// Counted when its route is matched and again as its response is made, so a visit between the two is checked once more, and the visit that follows the response sees the finished write; one a guard or the validation refuses (a 400, 401, 403, 405, 413, 415, 422 or 429) is counted by neither, so no visitor can make a page render again by sending those.
// The end count is a `mapResponse` and an `afterResponse`, never an `afterHandle` or `onError`, which would change how an API module answers; called before any route is added, as a hook reaches only the routes added after it.
export function countWrites(app: Elysia, own: string[] = []): Writes {
  let done = 0
  let active = 0
  const writes: Writes = { get count() {
    // A write in flight counts half a step, so a visit during it is checked once more after it, and a refused one leaves the count where it was.
    return active > 0 ? done + 0.5 : done
  } }
  const kay = new Set([...KAY_ROUTES, ...own])
  const started = new WeakSet<Request>()

  app.onTransform({ as: 'global' }, ({ request }) => {
    if (request.method !== 'GET' && request.method !== 'HEAD' && request.method !== 'OPTIONS' && !kay.has(withoutTrailingSlashes(pathOf(request.url)))) {
      started.add(request)
      active++
    }
  })
  const ended = ({ request, set, responseValue }: { request: Request, set: { status?: unknown }, responseValue?: unknown }) => {
    if (!started.delete(request))
      return

    active--

    if (!REFUSED.has(answeredWith(responseValue, set)))
      done++
  }

  app.mapResponse({ as: 'global' }, ended)
  // For an answer a `mapResponse` ahead of this one, or an error handler of the app, kept from reaching the one above.
  app.onAfterResponse({ as: 'global' }, ended)

  return writes
}

// Whether a kept page still renders as the build kept it, rendered live once per write however many visits wait for it.
// One that does not is dropped from `copies` for good, so it is rendered per request from then on, and the server says so once; a live render that failed settles nothing, and only this visit is rendered per request.
export async function stillKept(copies: Map<string, ServedPage>, key: string, page: ServedPage, writes: Writes, render: () => Promise<Response>): Promise<boolean> {
  const arrived = writes.count

  while (copies.get(key) === page && (page.checkedAt ?? 0) < arrived) {
    page.checking ??= check(copies, key, page, writes.count, render)

    if (await page.checking === undefined)
      return false
  }

  return copies.get(key) === page
}

async function check(copies: Map<string, ServedPage>, key: string, page: ServedPage, count: number, render: () => Promise<Response>): Promise<boolean | undefined> {
  let same: boolean | undefined

  try {
    const rendered = await withPageToken(page.token ?? pageToken(key), async () => {
      const response = await render()

      return { status: response.status, html: await response.text() }
    })

    same = rendered.status >= 500 ? undefined : rendered.status === page.status && pageEtag(rendered.html) === page.etag
  }
  catch {
    // The live render reports what it throws.
  }

  page.checking = undefined

  if (same === true)
    page.checkedAt = count

  if (same === false) {
    copies.delete(key)
    kayLog('warn', `the page ${key} was kept by the build, but renders differently now that a request has written: it is rendered per request from now on, which \`export const page = { prerender: false }\` says outright`)
  }

  return same
}
