import type { SQL } from 'bun'
import type { Duration } from '../runtime/duration'
import type { PgHandle } from './pg-data'
import type { Stop } from './pg-poll'
import type { RoomStore } from './rooms'
import { optionMs } from '../runtime/duration'
import { kayLog } from '../runtime/log'
import { outsideRequest } from './clean-context'
import { limited } from './pg-limit'
import { wakeOf } from './pg-notify'
import { closeWith, eventWindow, pollerOf } from './pg-poll'
import { escaped, NOW, query, unescaped } from './pg-sql'

// How often a process says it is alive, and how long after its last word its members stop counting.
const HEARTBEAT = 2_000
const EXPIRY = 10_000
// How long a message is kept, and how long a room nobody asked about stays among the ones read.
const KEPT = 30_000
const WATCH_KEPT = 30_000
const DEFAULT_POLL = optionMs('250ms', '')
// Writes waiting behind a database that stopped answering: past this many a new one is dropped and logged, rather than held in memory.
const MAX_QUEUED = 1000
// The rooms asked about but not held that are read at once: past this the ones asked about longest ago are forgotten, so names a visitor made up do not swell every poll.
const MAX_WATCHED = 1000

interface Own {
  room: string
  connection: string
  member: string
  at: number
}

type Listener = Parameters<RoomStore['subscribe']>[0]

// Awaits work nobody else holds, its failure logged.
async function logged(what: string, work: Promise<unknown>): Promise<void> {
  try {
    await work
  }
  catch (error) {
    kayLog('error', `${what} failed`, error)
  }
}

// What tells two reads of a room's members apart.
const signature = (members: Own[]): string => members.map(entry => `${entry.connection}\0${entry.member}`).toSorted().join('\n')

const SQLSTATE = /^[0-9A-Z]{5}$/

// Whether Postgres itself refused a statement (an SQLSTATE code), as against a connection lost or a call given up on.
const refused = (error: unknown): boolean => SQLSTATE.test(String((error as { errno?: unknown }).errno))

// How many times a change asks for a room's lock, a stuck update elsewhere letting go meanwhile; Postgres' lock_not_available.
const LOCK_ATTEMPTS = 3
const LOCK_NOT_AVAILABLE = '55P03'

// Waits for the room's lock for 5 seconds at most, so a stuck update elsewhere fails this one rather than holding the store's writes, the heartbeat's included; a leaving member asks up to `LOCK_ATTEMPTS` times.
async function lockRoom(tx: SQL, room: string): Promise<void> {
  await query(tx, 'SET LOCAL lock_timeout = \'5s\'')
  await query(tx, 'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`kay_room_state\n${escaped(room)}`])
}

// Under the room's lock, so an update storing a state for the member that just left finishes first; a lock not given in time is asked for again rather than left to the next prune.
async function dropEmptyState(db: SQL, room: string): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await db.begin(async (tx) => {
        await lockRoom(tx, room)
        await query(tx, 'DELETE FROM kay_room_state WHERE room = $1 AND NOT EXISTS (SELECT 1 FROM kay_room_members WHERE room = $1)', [escaped(room)])
      })

      return
    }
    catch (error) {
      if (attempt >= LOCK_ATTEMPTS || (error as { errno?: string }).errno !== LOCK_NOT_AVAILABLE)
        throw error
    }
  }
}

// The id of the last room message, or undefined when the database could not say.
async function messageHead(pg: PgHandle): Promise<number | undefined> {
  try {
    const [latest] = await query<{ id: string }>(await pg.db(), 'SELECT coalesce(max(id), 0)::text AS id FROM kay_room_messages')

    return Number(latest?.id ?? 0)
  }
  catch (error) {
    kayLog('error', 'reading where the room messages stand failed; the first poll takes it', error)

    return undefined
  }
}

// The store's writes in the order they were made.
function writeQueue(pg: PgHandle) {
  let tail: Promise<void> = Promise.resolve()
  let queued = 0
  let overflowing = false

  // Runs work once the ones queued before it did, in the order they were made, and gives its result, or its error, to the caller: a state is read and changed after the members written before it.
  // A caller waiting for the result gets it within one limit however many writes are queued before: `covering` has the limit run from the call, and the work given up on is cancelled as it starts. A write nobody awaits has its own limit once its turn comes.
  const ordered = async <T>(work: (db: SQL) => Promise<T>, covering = false): Promise<T> => {
    const prior = tail
    const run = covering
      ? limited('the rooms store', async () => {
        await prior

        return work(await pg.db())
      })
      : (async () => {
        await prior

        return limited('the rooms store', async () => work(await pg.db()))
      })()

    tail = (async () => {
      await prior

      try {
        await run
      }
      catch {
        // The caller of `run` has the error.
      }
    })()

    return run
  }

  // Like `ordered` for a write nobody awaits, its failure logged.
  const enqueue = (what: string, work: (db: SQL) => Promise<unknown>) => {
    if (queued >= MAX_QUEUED) {
      if (!overflowing)
        kayLog('error', `${what} failed: ${MAX_QUEUED} writes wait for the database, the ones after are dropped until it answers`)

      overflowing = true

      return
    }

    queued++
    void (async () => {
      try {
        await logged(what, ordered(work))
      }
      finally {
        queued--
        overflowing &&= queued > 0
      }
    })()
  }

  return { ordered, enqueue }
}

// Presence rooms in Postgres: a message published, a member joining or leaving in one replica reaches the others through `NOTIFY` at once, and by a poll every `poll`, `'250ms'` by default, as the fallback; a bare number throws. Once notifications are known to arrive, a poll that finds nothing new backs off to 30 seconds.
// A replica reads the members of the rooms it holds a connection in or asked `members` about, so one it asks about for the first time lists the others' members from its next poll. A replica that stops without leaving has its members dropped once it has not been heard from for 10 seconds.
// A room's state is a row of `kay_room_state`, changed under a lock per room so replicas updating one room take turns, and goes with the room's last member; `state` and `update` answer with promises, so `rooms({ store })` over it gives `Rooms`.
export function pgRooms(pg: PgHandle, { poll }: { poll?: Duration } = {}): RoomStore {
  const pollMs = poll === undefined ? DEFAULT_POLL : optionMs(poll, '`pgRooms` poll')
  const self = crypto.randomUUID()
  const own = new Map<string, Own>()
  // The members of the other replicas, by room, as of the last poll.
  const remote = new Map<string, Own[]>()
  // The rooms to read the members of, with when each was last asked about.
  const watched = new Map<string, number>()
  const listeners = new Set<Listener>()
  const events = eventWindow()
  let stopReadingTask: Stop | undefined
  let reading = false
  let beating: ReturnType<typeof setInterval> | undefined
  let pruned = 0
  let closed = false

  const { ordered, enqueue } = writeQueue(pg)
  const ownRooms = () => new Set([...own.values()].map(entry => entry.room))

  // Marks a room as asked about now, forgetting the ones asked about longest ago past `MAX_WATCHED`, the rooms this process holds kept.
  const watch = (room: string) => {
    // A room read for the first time is read at the base rate, however long the poll has slept.
    if (!watched.has(room))
      stopReadingTask?.wake()

    watched.delete(room)
    watched.set(room, Date.now())

    if (watched.size <= MAX_WATCHED)
      return

    const held = ownRooms()

    for (const name of watched.keys()) {
      if (watched.size <= MAX_WATCHED)
        break

      if (!held.has(name)) {
        watched.delete(name)
        remote.delete(name)
      }
    }
  }

  // The states of rooms with no member left.
  const dropStates = async (db: SQL) => {
    await query(db, 'DELETE FROM kay_room_state s WHERE NOT EXISTS (SELECT 1 FROM kay_room_members m WHERE m.room = s.room)')
  }

  // Tells the other replicas to read the rooms again, as a write changed what they read; delivered on commit, so it follows the statement it names.
  const wake = async (db: SQL) => {
    await query(db, 'SELECT pg_notify($1, $2)', wakeOf('rooms'))
  }

  // Drops the members of replicas gone quiet and the messages past `KEPT`.
  const prune = async (db: SQL) => {
    const gone = await query(db, `DELETE FROM kay_room_members WHERE process IN (SELECT process FROM kay_room_processes WHERE seen <= ${NOW} - ${EXPIRY}) RETURNING 1`)

    await query(db, `DELETE FROM kay_room_processes WHERE seen <= ${NOW} - ${EXPIRY}`)
    await dropStates(db)
    await query(db, `DELETE FROM kay_room_messages WHERE at <= ${NOW} - ${KEPT}`)

    // A replica that stopped without leaving is noticed here, so the others need not poll to find it.
    if (gone.length > 0)
      await wake(db)
  }

  const upsert = async (db: SQL, room: string, connection: string, member: string, at: number) => {
    await query(db, 'INSERT INTO kay_room_members (room, connection, process, member, at) VALUES ($1, $2, $3, $4, $5::bigint) ON CONFLICT (room, connection) DO UPDATE SET member = excluded.member', [escaped(room), connection, self, member, at])
    await wake(db)
  }

  const beat = () => {
    enqueue('marking this process alive in the rooms store', async (db) => {
      const [known] = await query<{ present: boolean }>(db, 'SELECT EXISTS (SELECT 1 FROM kay_room_processes WHERE process = $1) AS present', [self])

      await query(db, `INSERT INTO kay_room_processes (process, seen) VALUES ($1, ${NOW}) ON CONFLICT (process) DO UPDATE SET seen = excluded.seen`, [self])

      // Dropped while it was stalled: its members are written back.
      if (known?.present !== true) {
        for (const { room, connection, member, at } of own.values())
          await upsert(db, room, connection, member, at)
      }

      await prune(db)
    })
  }

  const readRooms = async (db: SQL, names: string[]) => {
    const rows = await query<{ room: string, connection: string, member: string, at: string }>(db, `SELECT m.room, m.connection, m.member, m.at FROM kay_room_members m JOIN kay_room_processes p ON p.process = m.process WHERE m.room = ANY($1::text[]) AND m.process <> $2 AND p.seen > ${NOW} - ${EXPIRY}`, [names.map(escaped), self])
    const byRoom = new Map<string, Own[]>()
    let changed = false

    for (const row of rows) {
      const room = unescaped(row.room)

      byRoom.set(room, [...byRoom.get(room) ?? [], { room, connection: row.connection, member: row.member, at: Number(row.at) }])
    }

    for (const room of names) {
      const next = byRoom.get(room) ?? []

      changed ||= signature(remote.get(room) ?? []) !== signature(next)
      remote.set(room, next)
    }

    return changed
  }

  const readMembers = async (db: SQL) => {
    const now = Date.now()

    for (const [room, asked] of watched) {
      if (now - asked > WATCH_KEPT && !ownRooms().has(room)) {
        watched.delete(room)
        remote.delete(room)
      }
    }

    if (watched.size === 0)
      return false

    const names = [...watched.keys()]

    try {
      return await readRooms(db, names)
    }
    catch (error) {
      // A lost connection or a timeout is the poller's to log and retry.
      if (!refused(error))
        throw error

      // A room the database refuses is left out and logged, the others read on.
      kayLog('error', 'reading the members of the other processes failed; reading the rooms one by one', error)

      const held = ownRooms()
      let changed = false

      for (const room of names) {
        try {
          changed = await readRooms(db, [room]) || changed
        }
        catch (single) {
          if (!refused(single))
            throw single

          kayLog('error', `reading the members of the room ${JSON.stringify(room)} failed; it is left out`, single)
          remote.delete(room)

          if (!held.has(room))
            watched.delete(room)
        }
      }

      return changed
    }
  }

  // The last message id as of a subscription, taken when it is made rather than by the first poll, which a poll asleep at its long idle rate would make late.
  let baseline: Promise<void> | undefined
  const takeBaseline = () => {
    baseline ??= (async () => {
      const head = await messageHead(pg)

      if (head !== undefined && events.from() === undefined)
        events.start([head])

      baseline = undefined
    })()
  }

  // Whether a message not read before was found.
  const readMessages = async (db: SQL) => {
    if (listeners.size === 0)
      return false

    // The baseline `subscribe` began is waited for, so a message published after the subscription is read even when the poll slept through it.
    if (events.from() === undefined && baseline !== undefined)
      await baseline

    const from = events.from()

    if (from === undefined) {
      // Read from now on: what others published before anyone here listened is for the members they had then.
      const [latest] = await query<{ id: string }>(db, 'SELECT coalesce(max(id), 0)::text AS id FROM kay_room_messages')

      events.start([Number(latest?.id ?? 0)])

      return false
    }

    let found = false

    // Ordered by the table column: a bare `id` is the text of the select list, where '100' sorts before '99'.
    for (const row of await query<{ id: string, room: string, text: string, skipped: string | null, recipient: string | null }>(db, 'SELECT id::text, room, text, skipped, recipient FROM kay_room_messages WHERE id > $1::bigint AND process <> $2 ORDER BY kay_room_messages.id', [from, self])) {
      const id = Number(row.id)

      if (events.has(id))
        continue

      events.note(id)
      found = true

      for (const listener of listeners) {
        try {
          listener(unescaped(row.room), row.text, { ...row.skipped !== null && { except: row.skipped }, ...row.recipient !== null && { to: row.recipient } })
        }
        catch (error) {
          kayLog('error', `a listener of the room ${row.room} threw`, error)
        }
      }
    }

    return found
  }

  const stopReading = () => {
    stopReadingTask?.()
    stopReadingTask = undefined
    events.forget()
  }

  const read = async (db: SQL): Promise<void | 'busy' | 'heard'> => {
    // A restarted reading does not begin while the one given up on is still running.
    if (reading)
      return 'busy'

    reading = true

    try {
      // The messages are read even when the members could not be, so a room the database refuses does not silence the others.
      let failure: unknown
      let changed = false

      try {
        changed = await readMembers(db)
      }
      catch (error) {
        failure = error
      }

      const found = await readMessages(db)

      if (failure !== undefined)
        throw failure

      return changed || found ? 'heard' : undefined
    }
    finally {
      reading = false

      // Rooms nobody asks about any more may have ended the reading.
      if (watched.size === 0 && listeners.size === 0)
        stopReading()
    }
  }

  // The process says it is alive only while it holds a connection, and reads the others' members and messages only while it has someone to tell or something asked.
  const sync = () => {
    const held = own.size > 0 && !closed

    if (held && beating === undefined) {
      beat()
      beating = outsideRequest(() => setInterval(beat, HEARTBEAT))
      beating.unref()
    }
    else if (!held && beating !== undefined) {
      clearInterval(beating)
      beating = undefined
    }

    const wanted = !closed && (listeners.size > 0 || watched.size > 0)

    if (wanted && stopReadingTask === undefined) {
      stopReadingTask = pollerOf(pg).add({ every: pollMs, backoff: 'listened', wanted: () => !closed, run: read, failed: 'reading the rooms of the other processes failed', listen: 'rooms' }, true)
    }
    else if (!wanted && stopReadingTask !== undefined) {
      stopReading()
    }
  }

  const store: RoomStore = {
    add(room, connection, member) {
      const key = `${room}\n${connection}`
      const at = own.get(key)?.at ?? Date.now()

      own.set(key, { room, connection, member, at })
      watch(room)
      sync()
      enqueue('adding a member to the rooms store', async db => upsert(db, room, connection, member, at))
    },
    remove(room, connection) {
      own.delete(`${room}\n${connection}`)
      sync()
      enqueue('removing a member from the rooms store', async (db) => {
        await query(db, 'DELETE FROM kay_room_members WHERE room = $1 AND connection = $2', [escaped(room), connection])
        await wake(db)
        await dropEmptyState(db, room)
      })
    },
    async state(room) {
      const [row] = await ordered(async db => query<{ state: string }>(db, 'SELECT state FROM kay_room_state WHERE room = $1', [escaped(room)]), true)

      return row?.state
    },
    // The transaction's advisory lock makes updates of one room wait for each other across replicas, a room with no row yet included.
    async update(room, change) {
      return ordered(async db => db.begin(async (tx) => {
        await lockRoom(tx, room)

        const [row] = await query<{ state: string }>(tx, 'SELECT state FROM kay_room_state WHERE room = $1', [escaped(room)])
        const next = change(row?.state)

        // A room no live process has a member in keeps nothing, so a room named by a client costs no row.
        await query(tx, `INSERT INTO kay_room_state (room, state) SELECT $1, $2 WHERE EXISTS (SELECT 1 FROM kay_room_members m JOIN kay_room_processes p ON p.process = m.process WHERE m.room = $1 AND p.seen > ${NOW} - ${EXPIRY}) ON CONFLICT (room) DO UPDATE SET state = excluded.state`, [escaped(room), next])

        return next
      }), true)
    },
    members(room) {
      watch(room)
      sync()

      const mine = [...own.values()].filter(entry => entry.room === room)
      const taken = new Set(mine.map(entry => entry.connection))

      return [...remote.get(room)?.filter(entry => !taken.has(entry.connection)) ?? [], ...mine]
        .sort((a, b) => a.at - b.at || (a.connection < b.connection ? -1 : 1))
        .map(entry => entry.member)
    },
    publish(room, text, recipients) {
      const now = Date.now()

      enqueue('publishing to the rooms store', async (db) => {
        await query(db, `WITH written AS (INSERT INTO kay_room_messages (room, text, process, skipped, recipient, at) VALUES ($1, $2, $3, $4, $5, ${NOW}) RETURNING id) SELECT pg_notify($6, $7) FROM written`, [escaped(room), text, self, recipients.except ?? null, recipients.to ?? null, ...wakeOf('rooms')])

        // A process only publishing has no beat, so its publishes prune, as often as a beat would.
        if (beating === undefined && now - pruned >= HEARTBEAT) {
          pruned = now
          await prune(db)
        }
      })

      for (const listener of listeners) {
        try {
          listener(room, text, recipients)
        }
        catch (error) {
          kayLog('error', `a listener of the room ${room} threw`, error)
        }
      }
    },
    subscribe(listener) {
      listeners.add(listener)

      if (events.from() === undefined && !closed)
        takeBaseline()

      sync()
      stopReadingTask?.wake()

      return () => {
        listeners.delete(listener)
        sync()
      }
    },
    async close(): Promise<void> {
      const had = own.size > 0

      closed = true
      clearInterval(beating)
      stopReading()
      beating = undefined
      listeners.clear()
      own.clear()

      if (had) {
        await logged('leaving the rooms store', ordered(async (db) => {
          await query(db, 'DELETE FROM kay_room_members WHERE process = $1', [self])
          await dropStates(db)
          await wake(db)
        }))
      }
    },
  }

  // A reload closes the store for the module that named it; the module running again names a store of its own.
  closeWith(pg, store.close)

  return store
}
