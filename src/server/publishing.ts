import type { Collection } from '../content'
import type { ServedPage } from './render'
import { contentKey, PUBLISH_TIMES } from '../content'
import { ALL_READS, onKeysInvalidated, refreshLocally } from '../runtime/cache'
import { kayLog } from '../runtime/log'
import { MAX_TIMER_MS } from './config-limits'

// How long after a failed read of the dates the next try comes.
const RETRY_MS = 60_000

const listeners = new Set<() => void>()

// Hears a date `publishAt` names pass, so what a server keeps beside the pages, such as the sitemap, is built afresh.
export function onPublished(listener: () => void): () => void {
  listeners.add(listener)

  return () => void listeners.delete(listener)
}

// The wait until `at`, no longer than a timer holds, which would fire at once.
export function delayUntil(at: number, now: number): number {
  return Math.min(Math.max(at - now, 0), MAX_TIMER_MS)
}

export interface Publishing {
  // Whether a date passed since the page was rendered, so it shows entries held back then.
  passed: (page: ServedPage) => boolean
  stop: () => void
  // Watches again after a `stop`, for an app that listens again.
  start: () => void
}

// What a server watching nothing holds, such as a static export or `kay dev`, which show every entry or are written once.
export const NOT_PUBLISHING: Publishing = { passed: () => false, stop: () => undefined, start: () => undefined }

// Refreshes the pages that read a collection with a `publishAt` when one of its dates passes, in this process alone: every replica has its clock and its pages, so none needs a lock, a store or a message from another.
// A date that passed while no server ran is caught up by `passed`, which compares it with the render of each page the build kept.
export async function watchPublishing(collections: Collection<unknown>[]): Promise<Publishing> {
  const watched = collections.filter(collection => collection.options.publishAt !== undefined)

  if (watched.length === 0)
    return NOT_PUBLISHING

  const latest = new Map<string, number>()
  let timer: ReturnType<typeof setTimeout> | undefined
  let generation = 0
  let stopped = false
  let since = Date.now()
  let next: number | undefined
  // A fired run superseded before it refreshed leaves its refresh to the run that took over.
  let owed = false

  const report = (error: unknown) => kayLog('error', 'the publication dates of a collection could not be read', error)
  const read = async (): Promise<Map<Collection<unknown>, number[]>> => {
    const times = new Map<Collection<unknown>, number[]>()

    for (const collection of watched)
      times.set(collection, await collection[PUBLISH_TIMES]())

    return times
  }

  // Arms the timer for the next date ahead; when `fired`, the timer of a date that passed, it first refreshes what read the collections holding one that passed since the last time.
  const run = async (fired: boolean): Promise<void> => {
    const mine = ++generation
    const early = next !== undefined && Date.now() < next

    owed ||= fired && !early
    clearTimeout(timer)
    next = undefined

    let times: Map<Collection<unknown>, number[]>

    try {
      times = await read()
    }
    catch (error) {
      report(error)

      if (!stopped && mine === generation) {
        timer = setTimeout(() => void run(false), RETRY_MS)
        timer.unref()
      }

      return
    }

    if (stopped || mine !== generation)
      return

    if (owed) {
      const now = Date.now()

      owed = false

      for (const [collection, dates] of times) {
        if (dates.some(at => at > since && at <= now))
          refreshLocally(contentKey(collection.name))
      }

      since = now

      for (const listener of listeners)
        listener()

      // Refreshing told this watcher of the change, which armed it again.
      if (mine !== generation)
        return
    }

    const now = Date.now()

    next = [...times.values()].flat().filter(at => at > now).reduce<number | undefined>((soonest, at) => soonest === undefined || at < soonest ? at : soonest, undefined)

    if (next !== undefined) {
      timer = setTimeout(() => void run(true), delayUntil(next, now))
      timer.unref()
    }
  }

  try {
    for (const [collection, times] of await read()) {
      const passed = times.findLast(at => at <= Date.now())

      if (passed !== undefined)
        latest.set(contentKey(collection.name), passed)
    }
  }
  catch (error) {
    report(error)
  }

  const listen = () => onKeysInvalidated((matches) => {
    if (watched.some(collection => matches(contentKey(collection.name))))
      void run(false)

    return []
  })
  let stopListening = listen()

  await run(false)

  return {
    passed: page => (page.reads ?? []).some(read => read === ALL_READS ? Math.max(...latest.values(), 0) > page.renderedAt : (latest.get(read) ?? 0) > page.renderedAt),
    stop: () => {
      stopped = true
      generation++
      next = undefined
      clearTimeout(timer)
      stopListening()
    },
    start: () => {
      if (!stopped)
        return

      stopped = false
      stopListening = listen()
      void run(true)
    },
  }
}
