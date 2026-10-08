import type { Elysia } from 'elysia'
import type { KayConfig } from '../config'
import { readCapped } from './errors'
import { clientAddress, overLimit } from './protection'
import { reportServerError } from './report'

// Where the browser reports what the Content-Security-Policy blocked, when `security.reports` is `true`.
export const CSP_REPORTS = '/_kay/csp'
// The name `report-to` and `Reporting-Endpoints` know the route by.
export const CSP_ENDPOINT = 'csp'
// A browser may batch several reports in one request, each carrying the whole policy.
const MAX_BODY_BYTES = 64 * 1024
const MAX_REPORTS_PER_BODY = 20
const MAX_FIELD_LENGTH = 2048
const REQUESTS_PER_MINUTE = 30
const MINUTE_MS = 60_000
// What the rate limit counts reports under, apart from any action's.
const REPORTS = 'kay:csp-reports'
// Past this many distinct violations, the oldest are forgotten and may be logged again.
const MAX_SEEN = 1000
const CONTROL_CHARACTERS = /\p{Cc}+/gu
const QUERY_OR_HASH = /[?#].*$/

// A violation of the site's policy as a browser reported it: what `onError` gets from kay's report route.
export class CspViolation extends Error {
  override name = 'CspViolation'

  constructor(
    // The directive that blocked it, such as `script-src-elem`.
    readonly directive: string,
    // What was blocked: a URL, or a keyword such as `inline` or `eval`.
    readonly blocked: string,
    // The page it was blocked on, its URL without query or hash.
    readonly url: string,
    // `report` when only the report-only policy would have blocked it.
    readonly disposition: 'enforce' | 'report',
    // The script that tried, `file:line:column`, when the browser says.
    readonly source?: string,
    // The first characters of a blocked inline script or style, when the directive asks for them with `'report-sample'`.
    readonly sample?: string,
  ) {
    super(`${directive} blocked ${blocked} on ${url}${disposition === 'report' ? ' (report only)' : ''}`)
    this.stack = source === undefined ? `${this.name}: ${this.message}` : `${this.name}: ${this.message}\n    at ${source}`
  }
}

const seen = new Set<string>()

// Takes the browser's violation reports, in the Reporting API's format or `report-uri`'s, logging each distinct one once per process and handing it to `onError`; a flood from one client or anything too big is refused.
export function serveViolationReports(app: Elysia, onError: KayConfig['onError']): void {
  app.post(CSP_REPORTS, async ({ request, server }) => {
    if (Number(request.headers.get('content-length') ?? 0) > MAX_BODY_BYTES)
      return new Response(null, { status: 413 })

    if (overLimit(REPORTS, clientAddress(request, server), REQUESTS_PER_MINUTE, MINUTE_MS) !== undefined)
      return new Response(null, { status: 429 })

    const text = await readCapped(request, MAX_BODY_BYTES)

    if (text === undefined)
      return new Response(null, { status: 413 })

    const violations = readViolations(text)

    if (!violations)
      return new Response(null, { status: 400 })

    for (const violation of violations) {
      const key = `${violation.directive} ${violation.blocked} ${violation.url}`

      if (seen.has(key))
        continue

      if (seen.size >= MAX_SEEN)
        seen.clear()

      seen.add(key)
      reportServerError(violation, request, onError)
    }

    return new Response(null, { status: 204 })
  }, { parse: 'none' })
}

// The violations a body holds, or undefined when it is no report: a Reporting API batch, its other report types skipped, or one `report-uri` report.
function readViolations(text: string): CspViolation[] | undefined {
  let body: unknown

  try {
    body = JSON.parse(text)
  }
  catch {
    return undefined
  }

  if (Array.isArray(body)) {
    const reports = body.slice(0, MAX_REPORTS_PER_BODY) as unknown[]

    return reports.flatMap((report) => {
      if (!isRecord(report) || report.type !== 'csp-violation' || !isRecord(report.body))
        return []

      const { documentURL, blockedURL, effectiveDirective, disposition, sourceFile, lineNumber, columnNumber, sample } = report.body
      const violation = violationOf(documentURL, blockedURL, effectiveDirective, disposition, sourceFile, lineNumber, columnNumber, sample)

      return violation ? [violation] : []
    })
  }

  const report = isRecord(body) ? body['csp-report'] : undefined

  if (!isRecord(report))
    return undefined

  const violation = violationOf(report['document-uri'], report['blocked-uri'], report['effective-directive'] ?? report['violated-directive'], report.disposition, report['source-file'], report['line-number'], report['column-number'], report['script-sample'])

  return violation ? [violation] : undefined
}

function violationOf(document: unknown, blocked: unknown, directive: unknown, disposition: unknown, file: unknown, line: unknown, column: unknown, sample: unknown): CspViolation | undefined {
  if (typeof document !== 'string' || typeof directive !== 'string' || directive === '')
    return undefined

  const source = typeof file === 'string' && file !== '' ? [file.replace(QUERY_OR_HASH, ''), line, column].filter(part => typeof part === 'number' || typeof part === 'string').join(':') : undefined

  return new CspViolation(
    clean(directiveName(directive)),
    typeof blocked === 'string' && blocked !== '' ? clean(blocked.replace(QUERY_OR_HASH, '')) : 'inline',
    clean(document.replace(QUERY_OR_HASH, '')),
    disposition === 'report' ? 'report' : 'enforce',
    source === undefined ? undefined : clean(source),
    typeof sample === 'string' && sample !== '' ? clean(sample) : undefined,
  )
}

// `violated-directive` may carry its sources after the name.
function directiveName(directive: string): string {
  const space = directive.indexOf(' ')

  return space === -1 ? directive : directive.slice(0, space)
}

// Anyone can post a report, so what it says reaches the log on one line and capped.
function clean(value: string): string {
  return value.replace(CONTROL_CHARACTERS, ' ').slice(0, MAX_FIELD_LENGTH)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
