import type { Elysia } from 'elysia'
import type { ServedPage } from './render'
import { kayLog } from '../runtime/log'
import { withPageToken } from '../runtime/uid.server'
import { ANALYTICS_PATH, CUSTOM_COLLECT_PATH } from './analytics'
import { ERROR_REPORTS } from './errors'
import { pageEtag, pageToken } from './prerendered'
import { CSP_REPORTS } from './violations'

// How many requests that can write have started or ended, which a kept page is checked against.
export interface Writes {
  count: number
}

// The requests counted as started, to count their end once.
const started = new WeakSet<Request>()

const TRAILING_SLASHES = /\/+$/
// What kay answers itself and no app code ever sees: the page-view and custom analytics beats, the browser's error reports and the policy's violation reports.
const REPORTS = new Set([ANALYTICS_PATH, CUSTOM_COLLECT_PATH, ERROR_REPORTS, CSP_REPORTS])

// A request that is not a GET, a HEAD or an OPTIONS can change what a page renders, an action as much as a route of the app, once a route answers it: one to no route, and kay's own reports, write nothing, so no visitor can force a page to render again by sending them.
// Counted when its route is reached and when it ends (`countWritesEnd`), so a visit between the two is checked again; called before any route is added, as a hook reaches only the routes added after it.
export function countWrites(app: Elysia): Writes {
  const writes: Writes = { count: 0 }

  app.onTransform({ as: 'global' }, ({ request }) => {
    if (request.method !== 'GET' && request.method !== 'HEAD' && request.method !== 'OPTIONS' && !REPORTS.has(new URL(request.url).pathname.replace(TRAILING_SLASHES, ''))) {
      started.add(request)
      writes.count++
    }
  })

  return writes
}

// Registered after the routes' own hooks, so the count has moved by the time the response is out and the visit that follows it is checked once.
export function countWritesEnd(app: Elysia, writes: Writes): void {
  app.onAfterResponse({ as: 'global' }, ({ request }) => {
    if (started.delete(request))
      writes.count++
  })
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
