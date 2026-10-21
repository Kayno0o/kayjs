import type { CollectionInfo } from './kay/contract'
import { effect, onCleanup, onMount, signal } from 'kay'

const LOCAL_INPUT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/
const MINUTE = 16
const DAY = 86_400_000
const UTC = 'UTC'
// The longest wait a timer holds, 2^31 - 1 milliseconds, beyond which it fires at once.
const MAX_TIMER_MS = 2_147_483_647

const formats = new Map<string, Intl.DateTimeFormat | undefined>()
const labels = new Map<string, Intl.DateTimeFormat | undefined>()

// The formatter of a zone's wall clock, or undefined for a name the engine does not know.
function wallClock(zone: string): Intl.DateTimeFormat | undefined {
  if (!formats.has(zone)) {
    try {
      formats.set(zone, new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }))
    }
    catch {
      formats.set(zone, undefined)
    }
  }

  return formats.get(zone)
}

// The zone as far as the engine knows it, UTC for none or an unknown name.
function known(zone: string | undefined): string {
  return zone !== undefined && wallClock(zone) !== undefined ? zone : UTC
}

// A date's time in milliseconds, or undefined for none or text that is no date.
function timeOf(value: unknown): number | undefined {
  const time = typeof value === 'string' ? Date.parse(value) : Number.NaN

  return Number.isNaN(time) ? undefined : time
}

// The wall clock of a zone at an instant, as the same numbers read as UTC: its difference with the instant is the zone's offset then.
function wallAsUtc(time: number, zone: string): number {
  const parts: Record<string, number> = {}

  for (const { type, value } of wallClock(zone)!.formatToParts(time))
    parts[type] = Number(value)

  return Date.UTC(parts.year!, parts.month! - 1, parts.day, parts.hour, parts.minute, parts.second)
}

const offsetAt = (time: number, zone: string): number => wallAsUtc(time, zone) - Math.floor(time / 1000) * 1000

// The zone the browser runs in, undefined where it cannot tell.
export function browserZone(): string | undefined {
  try {
    return new Intl.DateTimeFormat().resolvedOptions().timeZone
  }
  catch {
    return undefined
  }
}

// The zone the editor's browser runs in, undefined until the component calling it is mounted, as the server renders in UTC and the browser takes over from there; a signal of each call's own, so a component hydrating later in the same page starts on the UTC it was rendered in. Called in a component's script.
export function useEditorZone(): () => string | undefined {
  const zone = signal<string>()

  onMount(() => zone.set(browserZone()))

  return zone
}

// The editor's day on the browser's own clock, as a date input holds it: `2026-10-21`.
export function today(now = new Date()): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
}

// The current minute as an instant, which a datetime field stores.
export function thisMinute(now = Date.now()): string {
  return new Date(Math.floor(now / 60_000) * 60_000).toISOString()
}

// What a `datetime-local` input shows for a stored date: its minute on the wall clock of `zone`, UTC by default.
export function inputValue(stored: string, zone?: string): string {
  const time = timeOf(stored)

  return time === undefined ? '' : new Date(wallAsUtc(time, known(zone))).toISOString().slice(0, MINUTE)
}

// What the input's text stores: the instant the wall time names in `zone`, as a full UTC date `s.Date()` reads, or undefined once it is cleared. A time the clocks skip is the one a Date gives, an hour on, and one they repeat is its first.
export function storedValue(input: string, zone?: string): string | undefined {
  const match = LOCAL_INPUT.exec(input)
  const wall = match === null ? Number.NaN : Date.parse(`${input}:00Z`)

  if (Number.isNaN(wall))
    return undefined

  const at = known(zone)
  const before = offsetAt(wall - DAY, at)
  const after = offsetAt(wall + DAY, at)
  const candidates = [...new Set([before, after])].map(offset => wall - offset).filter(time => offsetAt(time, at) === wall - time).sort((a, b) => a - b)

  return new Date(candidates[0] ?? wall - before).toISOString()
}

// Names a zone at an instant: `UTC`, or the offset `GMT+2` it has then.
function zoneLabel(time: number, zone: string): string {
  if (!labels.has(zone))
    labels.set(zone, new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'short' }))

  return labels.get(zone)!.formatToParts(time).find(part => part.type === 'timeZoneName')?.value ?? zone
}

// The time in milliseconds an entry's `publishAt` date names, or undefined for an entry that has none or a collection with no `publishAt`.
export function publishTime(collection: Pick<CollectionInfo, 'publishField'>, data: Record<string, unknown> | undefined): number | undefined {
  return collection.publishField === undefined ? undefined : timeOf(data?.[collection.publishField])
}

// The time in milliseconds an entry's `unpublishAt` date names, or undefined for an entry that has none or a collection with no `unpublishAt`.
export function unpublishTime(collection: Pick<CollectionInfo, 'unpublishField'>, data: Record<string, unknown> | undefined): number | undefined {
  return collection.unpublishField === undefined ? undefined : timeOf(data?.[collection.unpublishField])
}

// Says when a date goes live, in `zone` (UTC by default), or nothing once it has passed.
export function goesLive(time: number, now = Date.now(), zone?: string): string | undefined {
  if (time <= now)
    return undefined

  const at = known(zone)

  return `${inputValue(new Date(time).toISOString(), at).replace('T', ' ')} ${zoneLabel(time, at)}`
}

// Says when the date `at` returns goes live, in the editor's zone (UTC until the browser says it), and nothing once it has passed or while `at` has none, with no reload: a timer wakes it as the date passes. Called in a component's script.
export function useGoesLive(at: () => number | undefined): () => string | undefined {
  const zone = useEditorZone()
  // Moves on each time a timer woke the reader.
  const woken = signal(0)

  // A timer holds 24 days at most, and one waking early finds the date still ahead and waits again.
  effect(() => {
    woken()

    const time = at()
    const wait = time === undefined ? 0 : time - Date.now()

    if (wait <= 0)
      return

    const timer = setTimeout(() => woken.set(woken() + 1), Math.min(wait, MAX_TIMER_MS))

    onCleanup(() => clearTimeout(timer))
  })

  return () => {
    woken()

    const time = at()

    return time === undefined ? undefined : goesLive(time, Date.now(), zone())
  }
}

// When something was typed, as the browser writes a short date and time: for what only exists once the browser holds a draft, so the server never renders it.
export function sinceText(at: number): string {
  const date = new Date(at)

  return `${date.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })} ${date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}`
}
