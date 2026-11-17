import type { RequestContext } from './request-context'
import { eventStream } from './event-stream'
import { fileAnswer } from './file-answer'

// What a handler returned that has no answer: named by its route, so the fix is where it is written.
export class UnsupportedAnswerError extends Error {
  override readonly name = 'UnsupportedAnswerError'
}

// A bigint is written as its digits, which JSON has no value for: the replacer swaps it for a marker string only this process knows, and the marker and its quotes are dropped from the text, so a string an app holds can never read as one.
const MARK = `__kay_bigint_${crypto.randomUUID()}_`
const MARKED = new RegExp(`"${MARK}(-?\\d+)"`, 'g')

function jsonText(value: unknown): string | undefined {
  let marked = false

  const text = JSON.stringify(value, (_key, held: unknown) => {
    if (typeof held !== 'bigint')
      return held

    marked = true

    return `${MARK}${held}`
  })

  return marked && text !== undefined ? text.replace(MARKED, '$1') : text
}

function isPlain(value: object): boolean {
  const prototype: unknown = Object.getPrototypeOf(value)

  return prototype === Object.prototype || prototype === null
}

function isEventSource(value: object): boolean {
  return Symbol.asyncIterator in value || Object.prototype.toString.call(value) === '[object Generator]'
}

// A response init whose status is only there when a handler set one.
function init(status: number | undefined, type: string): ResponseInit {
  return status === undefined ? { headers: { 'content-type': type } } : { status, headers: { 'content-type': type } }
}

function json(text: string, status: number | undefined): Response {
  return new Response(text, init(status, 'application/json'))
}

function named(context: RequestContext): string {
  const { route } = context

  return route === undefined ? `${context.method} ${context.url.pathname}` : `${route.method} ${route.path}`
}

// The Response a handler's value stands for, made once whatever the route kind:
// a Response as it is, text, JSON for an object, an array, a number, a boolean, null and a bigint, a Blob or a file with `Range` and `HEAD` answered, a stream, an event stream for an async generator, bytes, and 204 for nothing.
// A class instance, a Map or a function has no answer and fails the route, which says so by name.
// The status a handler set goes on a value that is not a Response.
export function answer(value: unknown, context: RequestContext): Response {
  if (value instanceof Response)
    return value

  const status = context.written?.status

  if (value === undefined)
    return new Response(null, { status: status ?? 204 })

  if (typeof value === 'string')
    return new Response(value, init(status, 'text/plain; charset=utf-8'))

  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint' || value === null)
    return json(jsonText(value)!, status)

  if (typeof value === 'object') {
    if (value instanceof Blob)
      return withStatus(fileAnswer(value, context.request), status)

    if (value instanceof ReadableStream)
      return new Response(value, init(status, 'application/octet-stream'))

    if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer)
      return new Response(value as BodyInit, init(status, 'application/octet-stream'))

    if (isEventSource(value))
      return withStatus(eventStream(value as AsyncIterable<unknown>), status)

    if (Array.isArray(value) || isPlain(value)) {
      const text = jsonText(value)

      if (text !== undefined)
        return json(text, status)
    }
  }

  const kind = typeof value === 'object' ? (value.constructor as { name?: string } | undefined)?.name ?? 'an object with no class' : typeof value

  throw new UnsupportedAnswerError(`kay: ${named(context)} returned ${kind}, which has no response; return a Response, text, a plain object or array, a file, a stream or an async generator`)
}

// A response with the status a handler set, when that is not the one it has.
function withStatus(response: Response, status: number | undefined): Response {
  return status === undefined || status === response.status ? response : new Response(response.body, { status, headers: response.headers })
}
