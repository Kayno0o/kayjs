import type { RoomStore } from './rooms'
import { kayLog } from '../runtime/log'
import { readPresenceWith } from '../runtime/presence'
import { appStore } from './app-store'
import { memoryRooms } from './rooms'

// What a presence room is called in the store, apart from the rooms an app's own `rooms()` keep there.
const PREFIX = 'kay:presence:'
// How long a tab that left is kept in its room, so a reconnect or a page swap does not show it leaving and coming back.
const GRACE_MS = 3000
// How often a room's members are read again, which picks up a process that crashed without leaving.
const RECHECK_MS = 5000

interface Seat {
  // The streams of the tab holding it.
  refs: number
  member: string
  leaving: ReturnType<typeof setTimeout> | undefined
}

type Recheck = (members: string[]) => void

// The tabs in a room by the room and the tab, and the streams watching a room.
const seats = new Map<string, Seat>()
const watchers = new Map<string, Set<Recheck>>()
let fallback: RoomStore | undefined
let subscription: { store: RoomStore, stop: () => void } | undefined
let ticker: ReturnType<typeof setInterval> | undefined

// The store of `kay.config.ts` `store.rooms`, or this process's memory.
function roomStore(): RoomStore {
  return appStore()?.rooms ?? (fallback ??= memoryRooms())
}

function membersOf(room: string): string[] {
  return roomStore().members(PREFIX + room)
}

// The room and member a presence key names, or undefined for a key that is none.
export function parsePresenceKey(key: string): { room: string, member: string } | undefined {
  try {
    const [room, member] = JSON.parse(key) as unknown[]

    return typeof room === 'string' ? { room, member: JSON.stringify(member ?? null) } : undefined
  }
  catch {
    return undefined
  }
}

readPresenceWith((key) => {
  const parsed = parsePresenceKey(key)

  return parsed === undefined ? [] : membersOf(parsed.room)
})

function recheckRoom(room: string): void {
  const rechecks = watchers.get(room)

  if (rechecks === undefined)
    return

  const members = membersOf(room)

  for (const recheck of rechecks)
    recheck(members)
}

// Hears the joins and leaves of every process sharing the store, once per store.
function listen(): void {
  const store = roomStore()

  if (subscription?.store === store)
    return

  subscription?.stop()
  subscription = { store, stop: store.subscribe((room) => {
    if (room.startsWith(PREFIX))
      recheckRoom(room.slice(PREFIX.length))
  }) }
}

function tell(room: string): void {
  roomStore().publish(PREFIX + room, '', {})
}

function join(room: string, tab: string, member: string): void {
  const at = `${room}\0${tab}`
  const seat = seats.get(at)

  if (seat === undefined) {
    seats.set(at, { refs: 1, member, leaving: undefined })
  }
  else {
    seat.refs++
    clearTimeout(seat.leaving)
    seat.leaving = undefined

    if (seat.member === member)
      return

    seat.member = member
  }

  listen()
  roomStore().add(PREFIX + room, tab, member)
  tell(room)
}

function leave(room: string, tab: string): void {
  const at = `${room}\0${tab}`
  const seat = seats.get(at)

  if (seat === undefined || --seat.refs > 0)
    return

  seat.leaving = setTimeout(() => {
    seats.delete(at)

    try {
      roomStore().remove(PREFIX + room, tab)
      tell(room)
    }
    catch (error) {
      kayLog('error', 'taking a tab out of a presence room failed', error)
    }
  }, GRACE_MS)
  seat.leaving.unref()
}

function startTicker(): void {
  ticker ??= setInterval(() => {
    for (const room of watchers.keys())
      recheckRoom(room)
  }, RECHECK_MS)
  ticker.unref()
}

// What a stream watching a presence key sends: the members of the room besides the tab's own, as JSON texts, a changed list after the first calling `notify`. It joins the room when it starts watching and leaves, after a short grace, when it stops.
export function presenceEntry(key: string, tab: string): { value: () => string[], watch: (notify: () => void) => () => void } | undefined {
  const parsed = parsePresenceKey(key)

  if (parsed === undefined)
    return undefined

  const { room, member } = parsed
  let last = ''
  const others = (members: string[]) => {
    const rest = [...members]
    const own = rest.indexOf(member)

    if (own !== -1)
      rest.splice(own, 1)

    return rest
  }

  return {
    value() {
      const rest = others(membersOf(room))

      last = JSON.stringify(rest)

      return rest
    },
    watch(notify) {
      const recheck: Recheck = (members) => {
        if (JSON.stringify(others(members)) !== last)
          notify()
      }

      join(room, tab, member)
      last = JSON.stringify(others(membersOf(room)))

      let rechecks = watchers.get(room)

      if (rechecks === undefined)
        watchers.set(room, rechecks = new Set())

      rechecks.add(recheck)
      startTicker()

      return () => {
        rechecks.delete(recheck)

        if (rechecks.size === 0 && watchers.get(room) === rechecks)
          watchers.delete(room)

        if (watchers.size === 0) {
          clearInterval(ticker)
          ticker = undefined
        }

        leave(room, tab)
      }
    },
  }
}
