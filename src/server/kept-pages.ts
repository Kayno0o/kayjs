import type { Elysia } from 'elysia'
import type { ServedPage } from './render'
import { kayLog } from '../runtime/log'
import { withPageToken } from '../runtime/uid'
import { pageEtag, pageToken } from './prerendered'

// How many requests that can write have started or ended, which a kept page is checked against.
export interface Writes {
  count: number
}

// A request that is not a GET or a HEAD can change what a page renders, an action as much as a route of the app; counted when it starts and when it ends, so a visit between the two is checked again.
export function countWrites(app: Elysia): Writes {
  const writes = { count: 0 }
  const counted = ({ request }: { request: Request }) => {
    if (request.method !== 'GET' && request.method !== 'HEAD')
      writes.count++
  }

  app.onRequest(counted)
  app.onAfterResponse({ as: 'global' }, counted)

  return writes
}

// Whether a kept page still renders as the build kept it, rendered live once per write however many visits wait for it.
// One that does not is dropped from `copies` for good, so it is rendered per request from then on, and the server says so once.
export async function stillKept(copies: Map<string, ServedPage>, key: string, page: ServedPage, writes: Writes, render: () => Promise<Response>): Promise<boolean> {
  while (copies.get(key) === page && (page.checkedAt ?? 0) !== writes.count) {
    page.checking ??= check(copies, key, page, writes.count, render)

    await page.checking
  }

  return copies.get(key) === page
}

async function check(copies: Map<string, ServedPage>, key: string, page: ServedPage, count: number, render: () => Promise<Response>): Promise<void> {
  let same = false

  try {
    const response = await withPageToken(pageToken(key), async () => {
      const rendered = await render()

      return { status: rendered.status, html: await rendered.text() }
    })

    same = response.status === page.status && pageEtag(response.html) === page.etag
  }
  catch {
    // The live render reports what it throws.
  }

  page.checking = undefined

  if (same) {
    page.checkedAt = count

    return
  }

  copies.delete(key)
  kayLog('warn', `the page ${key} was kept by the build, but renders differently now that a request has written: it is rendered per request from now on, which \`export const page = { prerender: false }\` says outright`)
}
