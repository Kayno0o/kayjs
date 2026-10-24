import { RETRY_LATER } from '../runtime/local-status'
import { appStore } from './app-store'
import { overHttps } from './request-url'
import { userOf } from './request-user'

// Sent by a `local()` collection with every write it replays: a retry of a write the server already ran gets the first answer back instead of running the action again.
export const WRITE_HEADER = 'x-kay-write'
const WRITE_ID = /^[\w-]{8,64}$/
const KEPT_MS = 7 * 24 * 60 * 60 * 1000
const MOST_KEPT = 5000
const PREFIX = 'kay:write:'
// Answers that depend on who asks or on the moment, which a retry may get differently: not kept, so the retry runs.
const NOT_KEPT = new Set<number>([401, 403, ...RETRY_LATER])
const SKIPPED_HEADERS = new Set(['set-cookie', 'date', 'content-length'])

interface Kept {
  status: number
  headers: [string, string][]
  body: string
  until: number
}

const memory = new Map<string, Kept>()
const running = new Map<string, Promise<Kept | undefined>>()

function remember(key: string, kept: Kept): void {
  memory.delete(key)
  memory.set(key, kept)

  for (const old of memory.keys()) {
    if (memory.size <= MOST_KEPT)
      break

    memory.delete(old)
  }
}

async function recall(key: string): Promise<Kept | undefined> {
  const found = memory.get(key)

  if (found !== undefined)
    return found.until > Date.now() ? found : (memory.delete(key), undefined)

  let stored

  try {
    stored = await appStore()?.cache?.get(key)
  }
  catch {
    return undefined
  }

  if (stored === undefined || stored.freshUntil <= Date.now())
    return undefined

  try {
    return { ...JSON.parse(stored.text) as Kept, until: stored.freshUntil }
  }
  catch {
    return undefined
  }
}

function replay({ status, headers, body }: Kept): Response {
  return new Response(body === '' ? null : body, { status, headers })
}

// Runs the action behind a call once per write id: the guards, the schema and the limits have already let it through, so a replayed answer goes to whoever those admit. The first answer of the write, a success or a refusal that will not change, is kept for a week, in `store.cache` when the app has one and in this process otherwise; a retry meanwhile waits for the first to end.
export async function onceWritten(request: Request, action: string, run: () => Promise<Response>): Promise<Response> {
  const id = request.headers.get(WRITE_HEADER)

  if (id === null || !WRITE_ID.test(id))
    return run()

  const key = `${PREFIX}${action}:${await userOf(request) ?? ''}:${id}`
  const earlier = running.get(key)

  if (earlier !== undefined) {
    const kept = await earlier

    if (kept !== undefined)
      return replay(kept)
  }

  // Told before anything is awaited, so a send arriving meanwhile waits for this one.
  let finish: (kept: Kept | undefined) => void = () => undefined
  const done = new Promise<Kept | undefined>((resolve) => {
    finish = resolve
  })

  running.set(key, done)

  try {
    const found = await recall(key)

    if (found !== undefined) {
      finish(found)

      return replay(found)
    }

    const response = await run()

    finish(await keep(key, response))

    return response
  }
  catch (error) {
    finish(undefined)

    throw error
  }
  finally {
    if (running.get(key) === done)
      running.delete(key)
  }
}

async function keep(key: string, response: Response): Promise<Kept | undefined> {
  if (response.status >= 500 || NOT_KEPT.has(response.status) || response.headers.get('content-type')?.startsWith('text/event-stream') === true)
    return undefined

  const type = response.headers.get('content-type') ?? ''

  // Only text is kept as text; a binary answer runs again.
  if (type !== '' && !type.startsWith('text/') && !type.includes('json'))
    return undefined

  let body: string

  try {
    body = await response.clone().text()
  }
  catch {
    return undefined
  }

  const kept: Kept = { status: response.status, headers: [...response.headers].filter(([name]) => !SKIPPED_HEADERS.has(name)), body, until: Date.now() + KEPT_MS }

  remember(key, kept)

  try {
    await appStore()?.cache?.set(key, JSON.stringify({ status: kept.status, headers: kept.headers, body: kept.body }), kept.until)
  }
  catch {}

  return kept
}

const CLEAR_COOKIE = 'kay_local_clear'
const CLEAR_MAX_AGE = 31_536_000

// The `Set-Cookie` that tells this browser to forget every `local()` mirror it holds: a sign-out adds it to its answer, and the next page using a collection empties its mirror and its queue, offline too. The value is new each time, and the cookie names no one and opens nothing.
export function forgetLocalMirrors(request: Request): string {
  return new Bun.Cookie(CLEAR_COOKIE, crypto.randomUUID(), { path: '/', sameSite: 'lax', secure: overHttps(request), maxAge: CLEAR_MAX_AGE }).serialize()
}
