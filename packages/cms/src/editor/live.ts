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

// The server's word of which instance answers, a stream that opens with its id and is held open: a rebuild replaces the instance, so the id heard next is another, with no page read to find it out.
export interface Instances {
  // Opens the stream; once is enough.
  start: () => void
  onData: (listener: (event: { value: string }) => void) => () => void
  // Called when the server refuses the stream, so nothing pushes and the page is read on an interval instead.
  onError: (listener: () => void) => () => void
}

interface Watch {
  read?: (url: string) => Promise<string | undefined>
  pause?: (ms: number) => Promise<void>
  interval?: number
  window?: number
  // Ends the watch early, as a newer save has taken over.
  cancelled?: () => boolean
  // Where the server pushes the instance it runs, which makes the watch wait for a replacement instead of reading on an interval.
  instances?: Instances
  // Ends the push watch as `cancelled` does for the interval one: a newer save, or the form going away.
  signal?: AbortSignal
}

// Reads the public page once the server behind the editor was replaced, which a rebuild does, and not on an interval: live when it then differs from how it stood right after the save and holds still for two reads. Reads on an interval after all when the server refuses the stream. False when the window passes first or the watch ends.
async function whenReplaced(url: string, instances: Instances, watch: Watch): Promise<boolean> {
  const { read = readPage, window = REBUILD_WINDOW, signal } = watch
  const before = await read(url) ?? ''

  return new Promise<boolean>((resolve) => {
    const stops: (() => void)[] = []
    let heard: string | undefined
    let checking = Promise.resolve()
    let timer: ReturnType<typeof setTimeout> | undefined

    const end = (live: boolean) => {
      clearTimeout(timer)

      for (const stop of stops)
        stop()

      resolve(live)
    }

    timer = setTimeout(end, window, false)

    signal?.addEventListener('abort', () => end(false), { once: true })

    stops.push(instances.onError(() => {
      // Reads on an interval from here on, from how the page stood when the save went through, for a window of its own.
      clearTimeout(timer)
      for (const stop of stops)
        stop()

      void (async () => end(await poll(url, before, watch)))()
    }))

    stops.push(instances.onData(({ value }) => {
      const replaced = heard !== undefined && value !== heard

      heard = value

      if (!replaced)
        return

      // One check at a time, in the order the replacements came.
      const after = checking

      checking = (async () => {
        await after

        const now = await read(url)

        if (now === undefined || now === before || signal?.aborted === true)
          return

        if (await read(url) === now)
          end(true)
      })()
    }))

    if (signal?.aborted === true)
      end(false)
    else
      instances.start()
  })
}

// Reads the public page until it differs from how it stood right after the save and then holds still for two reads, so a rebuild that is under way, or a page that changes on each request, does not count. False when the window passes first or the watch is cancelled: a page that does not show the saved fields never turns live. With `instances` the page is read when the server's instance changes instead, as long as the server pushes it.
export async function whenLive(url: string, watch: Watch = {}): Promise<boolean> {
  if (watch.instances)
    return whenReplaced(url, watch.instances, watch)

  return poll(url, await (watch.read ?? readPage)(url) ?? '', watch)
}

async function poll(url: string, before: string, { read = readPage, pause = sleep, interval = LIVE_INTERVAL, window = REBUILD_WINDOW, cancelled = () => false, signal }: Watch): Promise<boolean> {
  let candidate: string | undefined

  for (let waited = 0; waited < window; waited += interval) {
    await pause(interval)

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
