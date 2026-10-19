import type { Elysia } from 'elysia'
import type { ServedPage } from './render'
import { LIVE_ROUTE } from '../runtime/live-value'
import { kayLog } from '../runtime/log'
import { withPageToken } from '../runtime/uid.server'
import { ANALYTICS_PATH, CUSTOM_COLLECT_PATH } from './analytics'
import { ERROR_REPORTS } from './errors'
import { pathOf } from './log'
import { pageEtag, pageToken } from './prerendered'
import { CSP_REPORTS } from './violations'

// How many requests that can write have started or ended, which a kept page is checked against.
export interface Writes {
  count: number
}

// What kay answers itself and no app code ever sees: the page-view and custom analytics beats, the browser's error and violation reports and the live values' event stream.
const KAY_ROUTES = [ANALYTICS_PATH, CUSTOM_COLLECT_PATH, ERROR_REPORTS, CSP_REPORTS, LIVE_ROUTE]
const SLASH = 47

// A path without its trailing slashes, found by a scan rather than a pattern, as a hostile path may be mostly slashes.
function withoutTrailingSlashes(path: string): string {
  let end = path.length

  while (end > 1 && path.charCodeAt(end - 1) === SLASH)
    end--

  return path.slice(0, end)
}

// A request that is not a GET, a HEAD or an OPTIONS can change what a page renders, an action as much as a route of the app, once a route answers it: one to no route, and kay's own routes in `own` (the MCP endpoint among them, whose tool calls reach the app's actions and count there), write nothing, so no visitor can force a page to render again by sending them.
// Counted when its route is matched and again as its response is made, so a visit between the two is checked once more, and the visit that follows the response sees the finished write; a route matched is counted whatever its guards then answer.
// The end count is a `mapResponse` and an `afterResponse`, never an `afterHandle` or `onError`, which would change how an API module answers; called before any route is added, as a hook reaches only the routes added after it.
export function countWrites(app: Elysia, own: string[] = []): Writes {
  const writes: Writes = { count: 0 }
  const kay = new Set([...KAY_ROUTES, ...own])
  const started = new WeakSet<Request>()

  app.onTransform({ as: 'global' }, ({ request }) => {
    if (request.method !== 'GET' && request.method !== 'HEAD' && request.method !== 'OPTIONS' && !kay.has(withoutTrailingSlashes(pathOf(request.url)))) {
      started.add(request)
      writes.count++
    }
  })
  const ended = ({ request }: { request: Request }) => {
    if (started.delete(request))
      writes.count++
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
