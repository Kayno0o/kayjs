import type { Elysia } from 'elysia'
import type { KayConfig } from '../config'
import { isCrossSite } from './actions'
import { clientAddress, overLimit } from './protection'
import { reportServerError } from './report'

// Where the browser sends the errors islands meet.
export const ERROR_REPORTS = '/_kay/error'
// A report holds a message and a stack: past this it is no report.
const MAX_REPORT_BYTES = 16 * 1024
const MAX_URL_LENGTH = 2048
const REPORTS_PER_MINUTE = 20
const MINUTE_MS = 60_000
// What the rate limit counts reports under, apart from any action's.
const REPORTS = 'kay:error-reports'
// What a report could forge log lines, recolour a terminal or reorder text with: control characters, a stack keeping only its line breaks.
const CONTROL_CHARACTERS = /[\p{Cc}\p{Zl}\p{Zp}\p{Bidi_Control}]+/gu
const CONTROL_BUT_NEWLINES = /(?:(?!\n)[\p{Cc}\p{Zl}\p{Zp}\p{Bidi_Control}])+/gu
const INDENTED = /^\s/

// An error a browser met on a page of the app, as it reported it: what `onError` gets for errors islands throw.
export class BrowserError extends Error {
  override name = 'BrowserError'

  constructor(
    // The name of the error the browser met, such as `TypeError`.
    readonly kind: string,
    message: string,
    // The page it was met on, its path without query or hash.
    readonly url: string,
    stack: string | undefined,
    // The island it was met in, when the browser knows it: its component's path.
    readonly island?: string,
  ) {
    super(message)
    this.stack = stack === undefined ? `${kind}: ${message}` : stack
  }
}

// Takes the browser's reports, their stacks mapped to `.kay` lines through `mapStack`: in production the build's kept maps, under `kay dev` the chunks', logged and handed to `onError` as `BrowserError`s; another site's, a flood from one client, or anything too big is refused.
export function serveErrorReports(app: Elysia, onError: KayConfig['onError'], mapStack?: (stack: string) => Promise<string>): void {
  app.post(ERROR_REPORTS, async ({ request, server }) => {
    if (isCrossSite(request))
      return new Response(null, { status: 403 })

    if (Number(request.headers.get('content-length') ?? 0) > MAX_REPORT_BYTES)
      return new Response(null, { status: 413 })

    if (overLimit(REPORTS, clientAddress(request, server), REPORTS_PER_MINUTE, MINUTE_MS) !== undefined)
      return new Response(null, { status: 429 })

    const text = await readCapped(request, MAX_REPORT_BYTES)

    if (text === undefined)
      return new Response(null, { status: 413 })

    const report = readReport(text)

    if (!report)
      return new Response(null, { status: 400 })

    const stack = report.stack === undefined || mapStack === undefined ? report.stack : await mapStack(report.stack)

    reportServerError(new BrowserError(report.name, report.message, report.url, stack, report.island), request, onError)

    return new Response(null, { status: 204 })
  }, { parse: 'none' })
}

// The body, read only up to `max` bytes, whatever `content-length` claims or when it is missing; undefined past it.
export async function readCapped(request: Request, max: number): Promise<string | undefined> {
  const chunks: Uint8Array[] = []
  let size = 0

  for await (const chunk of request.body ?? []) {
    size += chunk.byteLength

    if (size > max)
      return undefined

    chunks.push(chunk)
  }

  return new TextDecoder().decode(Buffer.concat(chunks))
}

function readReport(text: string): { name: string, message: string, url: string, stack?: string | undefined, island?: string | undefined } | undefined {
  try {
    const { name, message, url, stack, island } = JSON.parse(text) as Record<string, unknown>

    if (typeof name !== 'string' || typeof message !== 'string' || typeof url !== 'string' || url.length > MAX_URL_LENGTH || (stack !== undefined && typeof stack !== 'string') || (island !== undefined && typeof island !== 'string'))
      return undefined

    return { name: oneLine(name), message: oneLine(message), url: oneLine(url), stack: stack === undefined ? undefined : framed(stack, `${oneLine(name)}: ${oneLine(message)}`), island: island === undefined ? undefined : oneLine(island) }
  }
  catch {
    return undefined
  }
}

function oneLine(text: string): string {
  return text.replace(CONTROL_CHARACTERS, ' ')
}

// A stack's lines indented but its own `Name: message` header, so no line of it reads as a log line of its own.
function framed(stack: string, header: string): string {
  return stack.replace(CONTROL_BUT_NEWLINES, ' ').split('\n').map((line, at) => (at === 0 && line.trimEnd() === header) || INDENTED.test(line) ? line : `    ${line}`).join('\n')
}
