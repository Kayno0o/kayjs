import type { SQL } from 'bun'
import type { Duration } from '../runtime/duration'
import type { PgHandle } from './pg-data'
import type { AsyncRoomStore } from './rooms'
import { optionMs } from '../runtime/duration'
import { kayLog } from '../runtime/log'
import { NOW, query } from './pg-sql'
import { onReload } from './reload'

// How often a process says it is alive, and how long after its last word its members stop counting.
const HEARTBEAT = 2_000
const EXPIRY = 10_000
// How long a message is kept, and how long a room nobody asked about stays among the ones read.
const KEPT = 30_000
const WATCH_KEPT = 30_000
const DEFAULT_POLL = optionMs('250ms', '')
// Ids this far behind the last one read are read again, as a transaction that began earlier may commit its message after a later one.
const OVERLAP = 100

interface Own {
  room: string
  connection: string
  member: string
  at: number
}

type Listener = Parameters<AsyncRoomStore['subscribe']>[0]

// Runs a write once the ones before it did, its failure logged: the writes of a store go to Postgres in the order they were made.
async function chained(prior: Promise<void>, what: string, work: () => Promise<unknown>): Promise<void> {
  await prior

  try {
    await work()
  }
  catch (error) {
    kayLog('error', `${what} failed`, error)
  }
}

// Presence rooms in Postgres: a message published in one replica reaches the members connected to the others within `poll`, `'250ms'` by default; a bare number throws.
// A replica reads the members of the rooms it holds a connection in or asked `members` about, so one it asks about for the first time lists the others' members from its next poll. A replica that stops without leaving has its members dropped once it has not been heard from for 10 seconds.
// A room's state is a row of `kay_room_state`, changed under a lock per room so replicas updating one room take turns, and goes with the room's last member; `state` and `update` answer with promises, so `rooms({ store })` over it gives `AsyncRooms`.
export function pgRooms(pg: PgHandle, { poll }: { poll?: Duration } = {}): AsyncRoomStore {
  const pollMs = poll === undefined ? DEFAULT_POLL : optionMs(poll, '`pgRooms` poll')
  const self = crypto.randomUUID()
  const own = new Map<string, Own>()
  // The members of the other replicas, by room, as of the last poll.
  const remote = new Map<string, Own[]>()
  // The rooms to read the members of, with when each was last asked about.
  const watched = new Map<string, number>()
  const listeners = new Set<Listener>()
  let tail: Promise<void> = Promise.resolve()
  let last: number | undefined
  const recent = new Set<number>()
  let reading: ReturnType<typeof setInterval> | undefined
  let beating: ReturnType<typeof setInterval> | undefined
  let polling = false
  // A streak of failed reads logs once, as the poll runs several times a second.
  let failing = false
  let pruned = 0
  let closed = false

  const enqueue = (what: string, work: (db: SQL) => Promise<unknown>) => {
    tail = chained(tail, what, async () => work(await pg.db()))
  }

  // Like `enqueue`, but gives the work's result, or its error, to the caller: a state is read and changed after the members written before it.
  const ordered = async <T>(work: (db: SQL) => Promise<T>): Promise<T> => {
    const prior = tail
    const run = (async () => {
      await prior

      return work(await pg.db())
    })()

    tail = (async () => {
      try {
        await run
      }
      catch {
        // The caller of `run` has the error.
      }
    })()

    return run
  }

  // Waits for the room's lock for 5 seconds at most, so a stuck update elsewhere fails this one rather than holding the store's writes, the heartbeat's included.
  const lockRoom = async (tx: SQL, room: string) => {
    await query(tx, 'SET LOCAL lock_timeout = \'5s\'')
    await query(tx, 'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`kay_room_state\n${room}`])
  }

  // The states of rooms with no member left.
  const dropStates = async (db: SQL) => {
    await query(db, 'DELETE FROM kay_room_state s WHERE NOT EXISTS (SELECT 1 FROM kay_room_members m WHERE m.room = s.room)')
  }

  // Drops the members of replicas gone quiet and the messages past `KEPT`.
  const prune = async (db: SQL) => {
    await query(db, `DELETE FROM kay_room_members WHERE process IN (SELECT process FROM kay_room_processes WHERE seen <= ${NOW} - ${EXPIRY})`)
    await query(db, `DELETE FROM kay_room_processes WHERE seen <= ${NOW} - ${EXPIRY}`)
    await dropStates(db)
    await query(db, `DELETE FROM kay_room_messages WHERE at <= ${NOW} - ${KEPT}`)
  }

  const upsert = async (db: SQL, room: string, connection: string, member: string, at: number) => {
    await query(db, 'INSERT INTO kay_room_members (room, connection, process, member, at) VALUES ($1, $2, $3, $4, $5::bigint) ON CONFLICT (room, connection) DO UPDATE SET member = excluded.member', [room, connection, self, member, at])
  }

  const ownRooms = () => new Set([...own.values()].map(entry => entry.room))

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

  const readMembers = async (db: SQL) => {
    const now = Date.now()

    for (const [room, asked] of watched) {
      if (now - asked > WATCH_KEPT && !ownRooms().has(room)) {
        watched.delete(room)
        remote.delete(room)
      }
    }

    if (watched.size === 0)
      return

    const names = [...watched.keys()]
    const rows = await query<{ room: string, connection: string, member: string, at: string }>(db, `SELECT m.room, m.connection, m.member, m.at FROM kay_room_members m JOIN kay_room_processes p ON p.process = m.process WHERE m.room IN (SELECT jsonb_array_elements_text($1::text::jsonb)) AND m.process <> $2 AND p.seen > ${NOW} - ${EXPIRY}`, [JSON.stringify(names), self])
    const byRoom = new Map<string, Own[]>()

    for (const row of rows)
      byRoom.set(row.room, [...byRoom.get(row.room) ?? [], { room: row.room, connection: row.connection, member: row.member, at: Number(row.at) }])

    for (const room of names)
      remote.set(room, byRoom.get(room) ?? [])
  }

  const readMessages = async (db: SQL) => {
    if (listeners.size === 0)
      return

    if (last === undefined) {
      // Read from now on: what others published before anyone here listened is for the members they had then.
      const [latest] = await query<{ id: string }>(db, 'SELECT coalesce(max(id), 0)::text AS id FROM kay_room_messages')

      last = Number(latest?.id ?? 0)

      return
    }

    for (const row of await query<{ id: string, room: string, text: string, skipped: string | null, recipient: string | null }>(db, 'SELECT id::text, room, text, skipped, recipient FROM kay_room_messages WHERE id > $1::bigint AND process <> $2 ORDER BY id', [last - OVERLAP, self])) {
      const id = Number(row.id)

      if (recent.has(id))
        continue

      recent.add(id)
      last = Math.max(last, id)

      for (const listener of listeners)
        listener(row.room, row.text, { ...row.skipped !== null && { except: row.skipped }, ...row.recipient !== null && { to: row.recipient } })
    }

    for (const id of recent) {
      if (id <= last - OVERLAP)
        recent.delete(id)
    }
  }

  const stopReading = () => {
    clearInterval(reading)
    reading = undefined
    last = undefined
    recent.clear()
  }

  const read = async () => {
    if (polling || closed)
      return

    polling = true

    try {
      const db = await pg.db()

      await readMembers(db)
      await readMessages(db)
      failing = false
    }
    catch (error) {
      if (!failing)
        kayLog('error', 'reading the rooms of the other processes failed; trying again', error)

      failing = true
    }
    finally {
      polling = false
    }

    // Rooms nobody asks about any more may have ended the reading.
    if (watched.size === 0 && listeners.size === 0)
      stopReading()
  }

  // The process says it is alive only while it holds a connection, and reads the others' members and messages only while it has someone to tell or something asked.
  const sync = () => {
    const held = own.size > 0 && !closed

    if (held && beating === undefined) {
      beat()
      beating = setInterval(beat, HEARTBEAT)
      beating.unref()
    }
    else if (!held && beating !== undefined) {
      clearInterval(beating)
      beating = undefined
    }

    const wanted = !closed && (listeners.size > 0 || watched.size > 0)

    if (wanted && reading === undefined) {
      reading = setInterval(() => void read(), pollMs)
      reading.unref()
      void read()
    }
    else if (!wanted && reading !== undefined) {
      stopReading()
    }
  }

  const store: AsyncRoomStore = {
    add(room, connection, member) {
      const key = `${room}\n${connection}`
      const at = own.get(key)?.at ?? Date.now()

      watched.set(room, Date.now())
      own.set(key, { room, connection, member, at })
      sync()
      enqueue('adding a member to the rooms store', async db => upsert(db, room, connection, member, at))
    },
    remove(room, connection) {
      own.delete(`${room}\n${connection}`)
      sync()
      enqueue('removing a member from the rooms store', async (db) => {
        await query(db, 'DELETE FROM kay_room_members WHERE room = $1 AND connection = $2', [room, connection])
        // Under the room's lock, so an update storing a state for the member that just left finishes first.
        await db.begin(async (tx) => {
          await lockRoom(tx, room)
          await query(tx, 'DELETE FROM kay_room_state WHERE room = $1 AND NOT EXISTS (SELECT 1 FROM kay_room_members WHERE room = $1)', [room])
        })
      })
    },
    async state(room) {
      const [row] = await ordered(async db => query<{ state: string }>(db, 'SELECT state FROM kay_room_state WHERE room = $1', [room]))

      return row?.state
    },
    // The transaction's advisory lock makes updates of one room wait for each other across replicas, a room with no row yet included.
    async update(room, change) {
      return ordered(async db => db.begin(async (tx) => {
        await lockRoom(tx, room)

        const [row] = await query<{ state: string }>(tx, 'SELECT state FROM kay_room_state WHERE room = $1', [room])
        const next = change(row?.state)

        // A room no live process has a member in keeps nothing, so a room named by a client costs no row.
        await query(tx, `INSERT INTO kay_room_state (room, state) SELECT $1, $2 WHERE EXISTS (SELECT 1 FROM kay_room_members m JOIN kay_room_processes p ON p.process = m.process WHERE m.room = $1 AND p.seen > ${NOW} - ${EXPIRY}) ON CONFLICT (room) DO UPDATE SET state = excluded.state`, [room, next])

        return next
      }))
    },
    members(room) {
      watched.set(room, Date.now())
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
        await query(db, `INSERT INTO kay_room_messages (room, text, process, skipped, recipient, at) VALUES ($1, $2, $3, $4, $5, ${NOW})`, [room, text, self, recipients.except ?? null, recipients.to ?? null])

        // A process only publishing has no beat, so its publishes prune, as often as a beat would.
        if (beating === undefined && now - pruned >= HEARTBEAT) {
          pruned = now
          await prune(db)
        }
      })

      for (const listener of listeners)
        listener(room, text, recipients)
    },
    subscribe(listener) {
      listeners.add(listener)
      sync()

      return () => {
        listeners.delete(listener)
        sync()
      }
    },
    close() {
      const had = own.size > 0

      closed = true
      clearInterval(beating)
      clearInterval(reading)
      beating = undefined
      reading = undefined
      listeners.clear()
      own.clear()

      if (had) {
        enqueue('leaving the rooms store', async (db) => {
          await query(db, 'DELETE FROM kay_room_members WHERE process = $1', [self])
          await dropStates(db)
        })
      }
    },
  }

  // A reload closes the store for the module that named it; the module running again names a store of its own.
  onReload(store.close)

  return store
}
