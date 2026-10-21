import { withBase } from 'kay'
import { REBUILD_WINDOW } from './rebuild'

// Where an entry stands after its last save: `live` once the public page serves what was saved, which a forge-backed site does only after a rebuild.
export interface SavedState { at: number, rebuilding: boolean, live?: boolean | undefined }

// How often the public page is read again while a save waits for the rebuild.
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

interface Watch {
  read?: (url: string) => Promise<string | undefined>
  pause?: (ms: number) => Promise<void>
  interval?: number
  window?: number
  // Ends the watch early, as a newer save has taken over.
  cancelled?: () => boolean
}

const sleep = async (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

// Reads the public page until it differs from how it stood right after the save and then holds still for two reads, so a rebuild that is under way, or a page that changes on each request, does not count. False when the window passes first or the watch is cancelled: a page that does not show the saved fields never turns live.
export async function whenLive(url: string, { read = readPage, pause = sleep, interval = LIVE_INTERVAL, window = REBUILD_WINDOW, cancelled = () => false }: Watch = {}): Promise<boolean> {
  const before = await read(url) ?? ''
  let candidate: string | undefined

  for (let waited = 0; waited < window; waited += interval) {
    await pause(interval)

    if (cancelled())
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

  const handler = ({ rebuilding }: { rebuilding: boolean }) => {
    const at = Date.now()
    const page = url()
    const mine = ++latest

    set({ at, rebuilding })

    if (!rebuilding || page === undefined)
      return

    void (async () => {
      const live = await whenLive(page, { ...watch, cancelled: () => latest !== mine })

      if (!live || latest !== mine)
        return

      set({ at, rebuilding: false, live: true })
      finished()
    })()
  }

  return Object.assign(handler, { stop: () => {
    latest++
  } })
}
