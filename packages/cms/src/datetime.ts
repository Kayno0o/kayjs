import type { CollectionInfo } from './kay/contract'

const LOCAL_INPUT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/
const MINUTE = 16
const UTC_LENGTH = 16

// A date's time in milliseconds, or undefined for none or text that is no date.
function timeOf(value: unknown): number | undefined {
  const time = typeof value === 'string' ? Date.parse(value) : Number.NaN

  return Number.isNaN(time) ? undefined : time
}

// What a `datetime-local` input shows for a stored date: its minute in UTC, as kay reads a date, so the screen on the server and the one in the browser agree whatever the zone each runs in.
export function inputValue(stored: string): string {
  const time = timeOf(stored)

  return time === undefined ? '' : new Date(time).toISOString().slice(0, MINUTE)
}

// What the input's text stores: a full UTC date `s.Date()` reads, or undefined once it is cleared.
export function storedValue(input: string): string | undefined {
  const time = LOCAL_INPUT.test(input) ? timeOf(`${input}:00Z`) : undefined

  return time === undefined ? undefined : new Date(time).toISOString()
}

// Says in UTC when an entry whose `publishAt` date is ahead goes live, or nothing for an entry that has none or whose date has passed.
export function scheduledFor(collection: Pick<CollectionInfo, 'publishField'>, data: Record<string, unknown> | undefined, now = Date.now()): string | undefined {
  const time = collection.publishField === undefined ? undefined : timeOf(data?.[collection.publishField])

  return time !== undefined && time > now ? `${new Date(time).toISOString().slice(0, UTC_LENGTH).replace('T', ' ')} UTC` : undefined
}
