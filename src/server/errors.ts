import type { Elysia } from 'elysia'
import type { KayConfig } from '../config'
import { isCrossSite } from './actions'
import { clientOf, overLimit } from './protection'
import { reportServerError } from './report'

// Where the browser sends the errors islands meet.
export const ERROR_REPORTS = '/_kay/error'
// A report holds a message and a stack: past this it is no report.
const MAX_REPORT_BYTES = 16 * 1024
const REPORTS_PER_MINUTE = 20
const MINUTE_MS = 60_000
// What the rate limit counts reports under, apart from any action's.
const REPORTS = {}

// An error a browser met on a page of the app, as it reported it: what `onError` gets for errors islands throw.
export class BrowserError extends Error {
  override name = 'BrowserError'

  constructor(
    // The name of the error the browser met, such as `TypeError`.
    readonly kind: string,
    message: string,
    // The page it was met on.
    readonly url: string,
    stack: string | undefined,
  ) {
    super(message)
    this.stack = stack === undefined ? `${kind}: ${message}` : stack
  }
}

// Takes the browser's reports, logged and handed to `onError` as `BrowserError`s; another site's, a flood from one client, or anything too big is refused.
export function serveErrorReports(app: Elysia, onError: KayConfig['onError']): void {
  app.post(ERROR_REPORTS, async ({ request, server }) => {
    if (isCrossSite(request))
      return new Response(null, { status: 403 })

    if (Number(request.headers.get('content-length') ?? 0) > MAX_REPORT_BYTES)
      return new Response(null, { status: 413 })

    if (overLimit(REPORTS, clientOf(request, server), REPORTS_PER_MINUTE, MINUTE_MS) !== undefined)
      return new Response(null, { status: 429 })

    const report = readReport(await request.text())

    if (!report)
      return new Response(null, { status: 400 })

    reportServerError(new BrowserError(report.name, report.message, report.url, report.stack), request, onError)

    return new Response(null, { status: 204 })
  }, { parse: 'none' })
}

function readReport(text: string): { name: string, message: string, url: string, stack?: string } | undefined {
  if (text.length > MAX_REPORT_BYTES)
    return undefined

  try {
    const { name, message, url, stack } = JSON.parse(text) as Record<string, unknown>

    if (typeof name !== 'string' || typeof message !== 'string' || typeof url !== 'string' || (stack !== undefined && typeof stack !== 'string'))
      return undefined

    return { name, message, url, stack }
  }
  catch {
    return undefined
  }
}
