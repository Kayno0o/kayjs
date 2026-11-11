import { sleep } from '@kaynooo/utils/function'
import { withBase } from 'kay'
import { REBUILD_WINDOW } from './rebuild'

// Where an entry stands after its last save: `live` once the public page serves what was saved, which a forge-backed site does only after a rebuild.
export interface SavedState { at: number, rebuilding: boolean, live?: boolean | undefined }

// How often the public page is read again while a save waits for the rebuild, for a browser the server cannot push to.
export const LIVE_INTERVAL = 4000

const NONCE = /\snonce="[^"]*"/g

// What a page answers, as comparable text: its status and body, undefined when it could not be read, without the nonce a response may carry per request.
export async function readPage(url: string): Promise<string | undefined> {
  try {
    const response = await fetch(withBase(url), { cache: 'no-store', credentials: 'same-origin' })

    // A site that is down or restarting is no sign of a rebuild done.
    return response.status >= 500 ? undefined : `${response.status}\n${(await response.text()).replaceAll(NONCE, '')}`
  }
  catch {
    return undefined
  }
}

// The server's word of which instance answers, a stream that opens with its id and is held open: a rebuild that replaces the server changes the id heard next.
export interface Instances {
  // Opens the stream; once is enough.
  start: () => void
  onData: (listener: (event: { value: string }) => void) => () => void
}

interface Watch {
  read?: (url: string) => Promise<string | undefined>
  pause?: (ms: number) => Promise<void>
  interval?: number
  window?: number
  // Ends the watch early, as a newer save has taken over.
  cancelled?: () => boolean
  // Where the server pushes the instance it runs, which makes the watch read the page when it is replaced, besides the slow reads it always makes.
  instances?: Instances
  // Ends the watch as `cancelled` does for the interval one: a newer save, or the form going away.
  signal?: AbortSignal
  // How long the poll waits before its read number `round` (from 0), instead of `interval`.
  delayOf?: (round: number) => number
}

// The slow reads that run beside the push: a site built and served elsewhere never replaces the cms's own server.
const SLOW_MS = 15_000
const SLOWER_MS = 30_000
const SLOW_ROUNDS = 4
// A replaced server may come before the rebuilt page does: the page is read again this often, this many times.
const RETRY_MS = 5000
const RETRIES = 4

// Reads the public page when the server behind the editor is replaced, which a rebuild does, and retries a few times over the next seconds, and on a slow interval all the while, for a site that is built and served elsewhere: live when the page then differs from how it stood right after the save and holds still for two reads. False when the window passes first or the watch ends.
async function whenReplaced(url: string, instances: Instances, watch: Watch): Promise<boolean> {
  const { read = readPage, pause = sleep, window = REBUILD_WINDOW, signal } = watch
  const before = await read(url) ?? ''

  return new Promise<boolean>((resolve) => {
    let stop: (() => void) | undefined
    let done = false
    const ended = () => done
    let heard: string | undefined
    let checking = Promise.resolve()
    let timer: ReturnType<typeof setTimeout> | undefined

    const end = (live: boolean) => {
      if (done)
        return

      done = true
      clearTimeout(timer)
      stop?.()
      resolve(live)
    }

    if (signal?.aborted === true) {
      end(false)

      return
    }

    timer = setTimeout(end, window, false)
    signal?.addEventListener('abort', () => end(false), { once: true })
    void (async () => end(await poll(url, before, { ...watch, delayOf: round => round < SLOW_ROUNDS ? SLOW_MS : SLOWER_MS, cancelled: () => done || watch.cancelled?.() === true })))()

    stop = instances.onData(({ value }) => {
      const replaced = heard !== undefined && value !== heard

      heard = value

      if (!replaced)
        return

      // One check at a time, in the order the replacements came.
      const after = checking

      checking = (async () => {
        await after

        for (let attempt = 0; attempt <= RETRIES && !ended(); attempt++) {
          if (attempt > 0)
            await pause(RETRY_MS)

          const now = done ? undefined : await read(url)

          if (now !== undefined && now !== before && await read(url) === now) {
            end(true)

            return
          }
        }
      })()
    })

    instances.start()
  })
}

// Reads the public page until it differs from how it stood right after the save and then holds still for two reads, so a rebuild that is under way, or a page that changes on each request, does not count. False when the window passes first or the watch is cancelled: a page that does not show the saved fields never turns live. With `instances` the page is also read at once when the server's instance changes.
export async function whenLive(url: string, watch: Watch = {}): Promise<boolean> {
  if (watch.instances)
    return whenReplaced(url, watch.instances, watch)

  return poll(url, await (watch.read ?? readPage)(url) ?? '', watch)
}

async function poll(url: string, before: string, { read = readPage, pause = sleep, interval = LIVE_INTERVAL, window = REBUILD_WINDOW, cancelled = () => false, signal, delayOf }: Watch): Promise<boolean> {
  let candidate: string | undefined

  for (let waited = 0, round = 0; waited < window; round++) {
    const delay = delayOf?.(round) ?? interval

    waited += delay
    await pause(delay)

    if (cancelled() || signal?.aborted === true)
      return false

    const now = await read(url)

    if (now === undefined)
      candidate = undefined
    else if (now === before)
      candidate = undefined
    else if (now === candidate)
      return true
    else
      candidate = now
  }

  return false
}

export type SavedHandler = ((saved: { rebuilding: boolean }) => void) & {
  // Ends the watch a save started, for the form's cleanup: the page is read no more and the rebuild notice is left alone.
  stop: () => void
}

// The handler a form gives `saveDraft` as `onSaved`: records the save, and for one that waits for a rebuild watches the entry's public page, if it has one, until it is live. A newer save, or `stop`, ends the older watch.
export function savedHandler(url: () => string | undefined, set: (state: SavedState) => void, finished: () => void, watch: Watch = {}): SavedHandler {
  let latest = 0
  let watching: AbortController | undefined

  const handler = ({ rebuilding }: { rebuilding: boolean }) => {
    const at = Date.now()
    const page = url()
    const mine = ++latest

    watching?.abort()
    watching = new AbortController()

    const { signal } = watching

    set({ at, rebuilding })

    if (!rebuilding || page === undefined)
      return

    void (async () => {
      const live = await whenLive(page, { ...watch, signal, cancelled: () => latest !== mine })

      if (!live || latest !== mine)
        return

      set({ at, rebuilding: false, live: true })
      finished()
    })()
  }

  return Object.assign(handler, { stop: () => {
    latest++
    watching?.abort()
  } })
}
