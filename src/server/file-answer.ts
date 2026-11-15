import { basename } from 'node:path'

export interface FileAnswerOptions {
  /** Has the browser save the file instead of showing it, under this name, or the file's own name with `true`. */
  attachment?: string | boolean | undefined
  /** The `content-type`; the file's own, else bytes of no type. */
  type?: string | undefined
  /** The `cache-control`; none by default. */
  cacheControl?: string | undefined
  /** Headers added to the answer, which win over the ones kay sets. */
  headers?: Record<string, string> | undefined
}

const RANGE = /^bytes=(\d*)-(\d*)$/
const PLAIN_NAME = /^[\w. -]+$/
const UNSAFE_NAME_CHARACTER = /[^\x20-\x7E]|["\\%;]/g
const RFC5987_RESERVED = /['()*]/g

/** A download's `content-disposition`: the name as it is when plain, else an ASCII fallback beside the exact name percent-encoded, so a quote, a line break or a non-ASCII character never breaks the header. */
export function attachmentHeader(name: string): string {
  const last = basename(name) || 'download'

  if (PLAIN_NAME.test(last))
    return `attachment; filename="${last}"`

  const encoded = encodeURIComponent(last).replace(RFC5987_RESERVED, character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`)

  return `attachment; filename="${last.replace(UNSAFE_NAME_CHARACTER, '_')}"; filename*=UTF-8''${encoded}`
}

/** A file as a response for a route of the app's own: one `Range` answered 206 (past the end 416), `accept-ranges`, `HEAD` with no body, and a download name. */
export function fileAnswer(file: Blob, request: Request | undefined, options: FileAnswerOptions = {}): Response {
  const { attachment } = options
  const headers: Record<string, string> = { 'content-type': options.type ?? (file.type || 'application/octet-stream'), 'x-content-type-options': 'nosniff' }

  if (attachment !== undefined && attachment !== false)
    headers['content-disposition'] = attachmentHeader(typeof attachment === 'string' && attachment !== '' ? attachment : (file as { name?: string }).name ?? '')

  if (options.cacheControl !== undefined)
    headers['cache-control'] = options.cacheControl

  return answer(file, request, { ...headers, ...Object.fromEntries(Object.entries(options.headers ?? {}).map(([name, value]) => [name.toLowerCase(), value])) }, headers => headers)
}

/** Answers `data` whole or by range under `headers`, `own` finishing the headers of an answer from a route. */
export function answer(data: Blob, request: Request | undefined, headers: Record<string, string>, own: (headers: Record<string, string>) => Record<string, string>): Response {
  const head = request?.method === 'HEAD'

  // An S3 object's size is only known by asking for it, so its file goes whole, streamed: Bun answers an S3 file given as the body with nothing.
  const size = Number.isFinite(data.size) ? data.size : undefined

  if (size === undefined)
    return new Response(head ? null : data.stream(), { headers: own(headers) })

  headers['accept-ranges'] = 'bytes'

  const range = request === undefined ? null : parseRange(request.headers.get('range'), size)

  if (range === 'unsatisfiable')
    return new Response(null, { status: 416, headers: own({ ...headers, 'content-range': `bytes */${size}` }) })

  if (range === null)
    return new Response(head ? null : data, { headers: own({ ...headers, 'content-length': String(size) }) })

  const [start, end] = range

  return new Response(head ? null : data.slice(start, end + 1), { status: 206, headers: own({ ...headers, 'content-length': String(end - start + 1), 'content-range': `bytes ${start}-${end}/${size}` }) })
}

// One `bytes=a-b`, `bytes=a-` or `bytes=-n`; any other header (several ranges, another unit, a malformed or reversed one) is ignored, so the whole file is answered.
function parseRange(header: string | null, size: number): [number, number] | 'unsatisfiable' | null {
  const match = RANGE.exec(header ?? '')

  if (!match || (match[1] === '' && match[2] === ''))
    return null

  const first = match[1] === '' ? undefined : Number(match[1])
  const last = match[2] === '' ? undefined : Number(match[2])

  if (first === undefined) {
    // `bytes=-500` asks for the last 500 bytes.
    return last === 0 || size === 0 ? 'unsatisfiable' : [Math.max(0, size - last!), size - 1]
  }

  if (last !== undefined && last < first)
    return null

  return first >= size ? 'unsatisfiable' : [first, Math.min(last ?? size - 1, size - 1)]
}
