import type { FSWatcher } from 'node:fs'
import type { Duration } from '../runtime/duration'
import { watch } from 'node:fs'
import { basename, dirname } from 'node:path'
import { t } from 'elysia'
import { optionMs } from '../runtime/duration'
import { kayLog } from '../runtime/log'
import { openSqlite } from '../runtime/sqlite.server'
import { onReload } from './reload'

// What a room sends a connection through: Elysia's `ws`, read through its raw socket, the one object that stays the same from `open` to `close`.
export interface RoomConnection {
  raw: object & { sendText: (text: string) => unknown }
}

// Who in a room a message goes to: everyone but the connection `except` names, and only the members equal to `to`, as JSON, when given.
export interface RoomRecipients {
  except?: string
  to?: string
}

type RoomListener = (room: string, text: string, recipients: RoomRecipients) => void

// Where members and messages are kept, for one process or every process of the machine; `RoomStore` keeps a room's state at once, `AsyncRoomStore` through promises.
export interface RoomStoreBase {
  // Records a connection of this process in a room, with its member as JSON, or drops it.
  add: (room: string, connection: string, member: string) => void
  remove: (room: string, connection: string) => void
  // The members of a room, as JSON, in every process sharing the store.
  members: (room: string) => string[]
  // Hands a message to the listeners of every process sharing the store, this one's included.
  publish: (room: string, text: string, recipients: RoomRecipients) => void
  // Called with each message published from then on; returns what stops it.
  subscribe: (listener: RoomListener) => () => void
  // Stops what the store runs in the background and lets go of its file.
  close: () => void
}

export interface RoomStore extends RoomStoreBase {
  // The state of a room as JSON, in every process sharing the store; undefined while it holds none. A store without it cannot keep a room's state.
  state?: (room: string) => string | undefined
  // Replaces a room's state with what `change` makes of the current one, as JSON, one change at a time in every process sharing the store, and gives what it stored. A room's state goes with its last member.
  update?: (room: string, change: (current: string | undefined) => string) => string
}

// A store whose room state waits on a database, such as `pgData(db).rooms`: `rooms({ store })` over it answers `state` and `update` with promises.
export interface AsyncRoomStore extends RoomStoreBase {
  state?: (room: string) => Promise<string | undefined>
  update?: (room: string, change: (current: string | undefined) => string) => Promise<string>
}

export interface RoomsOptions<Message = never, State = undefined, Store = RoomStore> {
  // `sqliteRooms(path)` reaches every process of the machine; one process's memory by default. `pgData(db).rooms` does across replicas, and makes `state` and `update` answer with promises.
  store?: Store | undefined
  // What a room's state is before any `update`, called each time one is read or changed while the room has none. The state is kept as JSON, whole, so a `Date` in it comes back as text.
  state?: (() => State) | undefined
  // The message a connection is sent, alone, as it joins, from the room's state as it then stands: a late joiner starts where the others are.
  snapshot?: ((state: State, room: string) => Message) | undefined
}

export interface CoalesceOptions {
  // How long changes are gathered before the one snapshot goes, `'50ms'` by default.
  wait?: Duration | undefined
}

export interface RoomsBase<Message, Member = undefined> {
  // Puts a connection in a room, with what the room lists it as; joining again changes its member.
  join: (ws: RoomConnection, room: string, ...member: undefined extends Member ? [member?: Member] : [member: Member]) => void
  // Takes a connection out of a room, or out of every room it is in, as `close` does.
  leave: (ws: RoomConnection, room?: string) => void
  // The rooms a connection of this process is in.
  roomsOf: (ws: RoomConnection) => string[]
  // The member this process's connection joined a room as, undefined for one that is not in it or joined with none.
  memberOf: (ws: RoomConnection, room: string) => Member | undefined
  // A `response` schema for the ws routes of these rooms: it takes any message and types it as `Message`, so an island's `socket()` gets typed messages without a schema written for typing only. Nothing is checked against it.
  response: ReturnType<typeof t.Unsafe<Message>>
  // The members of a room, in every process sharing the store; a room no one is in is gone, and lists none.
  members: (room: string) => Member[]
  // Sends a message to everyone in a room, but `except` when given, such as the connection it came from, or only to the connections joined as the member `to` names, such as a game's host.
  publish: (room: string, message: Message, options?: { except?: RoomConnection, to?: Member }) => void
  // A function sending a room one snapshot, read when it goes, however many times it is called within `wait`: a burst of changes goes out as one message. `read` may answer with a promise, as over an async store.
  coalesce: (read: (room: string) => Message | Promise<Message>, options?: CoalesceOptions) => (room: string) => void
}

export interface Rooms<Message, Member = undefined, State = undefined> extends RoomsBase<Message, Member> {
  // The room's state, the `state` option's initial one while no `update` made another. A room's state is gone when its last member leaves.
  state: (room: string) => State
  // Replaces the room's state with what `change` returns for the one it has, one change at a time in every process sharing the store, and gives the new one. `change` runs inside the store's turn: it must be quick and read nothing but its argument. Nothing is sent: publish the change, or its snapshot, to the members.
  update: (room: string, change: (state: State) => State) => State
}

// The rooms over an `AsyncRoomStore`: `state` and `update` resolve once the store answered.
export interface AsyncRooms<Message, Member = undefined, State = undefined> extends RoomsBase<Message, Member> {
  state: (room: string) => Promise<State>
  update: (room: string, change: (state: State) => State) => Promise<State>
}

const DEFAULT_WAIT = '50ms'
// How a connection joined without a member is written, apart from one joined as `null`, which is JSON.
const NO_MEMBER = ''
// How often a process says it is alive, and how long after its last word its members stop counting.
const HEARTBEAT = 2_000
const EXPIRY = 10_000
// How often a process reads the messages others wrote, and how long they are kept: a write by another process wakes the read at once, so this is only the net under it, and a file whose changes cannot be watched is read at the shorter interval.
const WATCHED_POLL_MS = optionMs('250ms', '')
const UNWATCHED_POLL_MS = optionMs('25ms', '')
const KEPT = 30_000

// Rooms of websocket connections, typed by what they send: join one in `open`, leave in `close`, and publish to it from anywhere.
export function rooms<Message, Member = undefined, State = undefined>(...[options]: undefined extends State ? [options?: RoomsOptions<Message, State>] : [options: RoomsOptions<Message, State> & { state: () => State }]): Rooms<Message, Member, State>
export function rooms<Message, Member = undefined, State = undefined>(...[options]: undefined extends State ? [options: RoomsOptions<Message, State, AsyncRoomStore> & { store: AsyncRoomStore }] : [options: RoomsOptions<Message, State, AsyncRoomStore> & { store: AsyncRoomStore, state: () => State }]): AsyncRooms<Message, Member, State>
export function rooms<Message, Member, State>(...[options = {}]: [options?: RoomsOptions<Message, State, RoomStore | AsyncRoomStore>]): RoomsBase<Message, Member> & { state: (room: string) => State | Promise<State>, update: (room: string, change: (state: State) => State) => State | Promise<State> } {
  const store: RoomStore | AsyncRoomStore = options.store ?? memoryRooms()

  if ((options.state !== undefined || options.snapshot !== undefined) && (store.state === undefined || store.update === undefined))
    throw new Error('kay: rooms({ state }) needs a store that keeps a room\'s state, and this one has no `state` and `update`')

  // Through JSON as a stored state is, so a state has one shape before and after an update.
  const initial = (): State => {
    const text = JSON.stringify(options.state?.())

    return (text === undefined ? undefined : JSON.parse(text)) as State
  }
  const readState = (room: string): State | Promise<State> => after(store.state!(room), kept => (kept === undefined ? initial() : JSON.parse(kept) as State))
  // The connections of this process in each room, by their id, with their member as JSON, or empty without one.
  const local = new Map<string, Map<string, { raw: RoomConnection['raw'], member: string }>>()
  const ids = new WeakMap<object, string>()
  const joined = new WeakMap<object, Set<string>>()
  let subscribed = false

  const idOf = (raw: object) => {
    let id = ids.get(raw)

    if (id === undefined)
      ids.set(raw, id = crypto.randomUUID())

    return id
  }

  const deliver: RoomListener = (room, text, { except, to }) => {
    for (const [id, { raw, member }] of local.get(room) ?? []) {
      if (id !== except && (to === undefined || to === member))
        raw.sendText(text)
    }
  }

  const leaveOne = (raw: object, room: string) => {
    const id = idOf(raw)
    const members = local.get(room)

    members?.delete(id)

    if (members?.size === 0)
      local.delete(room)

    joined.get(raw)?.delete(room)
    store.remove(room, id)
  }

  return {
    response: t.Unsafe<Message>(t.Any()),
    memberOf(ws, room) {
      const written = local.get(room)?.get(idOf(ws.raw))?.member

      return written === undefined || written === NO_MEMBER ? undefined : JSON.parse(written) as Member
    },
    join(ws, room, ...[member]) {
      const id = idOf(ws.raw)
      const written = member === undefined ? NO_MEMBER : JSON.stringify(member)

      if (!subscribed) {
        store.subscribe(deliver)
        subscribed = true
      }

      local.set(room, (local.get(room) ?? new Map<string, { raw: RoomConnection['raw'], member: string }>()).set(id, { raw: ws.raw, member: written }))
      joined.set(ws.raw, (joined.get(ws.raw) ?? new Set()).add(room))
      store.add(room, id, written)

      // The member is listed first, so a change made while it joins reaches it as the snapshot or as what is published after.
      if (options.snapshot) {
        // A connection that left while an async state was read gets nothing.
        const send = (state: State) => {
          if (local.get(room)?.has(id))
            ws.raw.sendText(messageText(options.snapshot!(state, room)))
        }
        const sent = after(readState(room), send)

        if (sent instanceof Promise)
          void settled('sending a joiner its snapshot', sent)
      }
    },
    leave(ws, room) {
      for (const name of room === undefined ? [...joined.get(ws.raw) ?? []] : [room])
        leaveOne(ws.raw, name)
    },
    roomsOf: ws => [...joined.get(ws.raw) ?? []],
    members: room => store.members(room).map(member => (member === NO_MEMBER ? undefined : JSON.parse(member)) as Member),
    state: readState,
    update: (room, change): State | Promise<State> => after(store.update!(room, (kept) => {
      const next = JSON.stringify(change(kept === undefined ? initial() : JSON.parse(kept) as State))

      if (next === undefined)
        throw new TypeError('kay: a room\'s state must be JSON, and `update` returned a value with none')

      return next
    }), text => JSON.parse(text) as State),
    publish(room, message, { except, to } = {}) {
      store.publish(room, messageText(message), { ...except && { except: idOf(except.raw) }, ...to !== undefined && { to: JSON.stringify(to) } })
    },
    coalesce(read, { wait = DEFAULT_WAIT } = {}) {
      const delay = optionMs(wait, '`coalesce` wait')

      // The rooms a snapshot is on its way to.
      const waiting = new Set<string>()

      return (room) => {
        if (waiting.has(room))
          return

        waiting.add(room)
        setTimeout(guarded('sending a room its snapshot', () => {
          waiting.delete(room)

          const sent = after(read(room), message => store.publish(room, messageText(message), {}))

          if (sent instanceof Promise)
            void settled('sending a room its snapshot', sent)
        }), delay)
      }
    },
  }
}

// What `next` makes of a value, at once for a value and once it resolved for a promise, so a sync store stays sync.
function after<T, R>(value: T | Promise<T>, next: (value: T) => R): R | Promise<R> {
  return value instanceof Promise ? (async () => next(await value))() : next(value)
}

// Awaits a promise nobody else holds, its error logged.
async function settled(what: string, work: Promise<unknown>): Promise<void> {
  try {
    await work
  }
  catch (error) {
    kayLog('error', `${what} failed`, error)
  }
}

// A message as Elysia sends one: a string as it is, anything else as JSON.
function messageText(message: unknown): string {
  return typeof message === 'string' ? message : JSON.stringify(message)
}

// What a timer runs, its error logged rather than taking the process down.
function guarded(what: string, run: () => void): () => void {
  return () => {
    try {
      run()
    }
    catch (error) {
      kayLog('error', `${what} failed`, error)
    }
  }
}

// Rooms in this process's memory, gone when it stops.
export function memoryRooms(): RoomStore {
  const byRoom = new Map<string, Map<string, string>>()
  const states = new Map<string, string>()
  const listeners = new Set<RoomListener>()

  return {
    add(room, connection, member) {
      byRoom.set(room, (byRoom.get(room) ?? new Map<string, string>()).set(connection, member))
    },
    remove(room, connection) {
      const members = byRoom.get(room)

      members?.delete(connection)

      if (members?.size === 0) {
        byRoom.delete(room)
        states.delete(room)
      }
    },
    members: room => [...byRoom.get(room)?.values() ?? []],
    state: room => states.get(room),
    update(room, change) {
      const next = change(states.get(room))

      if (byRoom.has(room))
        states.set(room, next)

      return next
    },
    publish(room, text, recipients) {
      for (const listener of listeners)
        listener(room, text, recipients)
    },
    subscribe(listener) {
      listeners.add(listener)

      return () => listeners.delete(listener)
    },
    close() {
      listeners.clear()
    },
  }
}

// Rooms kept in a SQLite file every process of the machine opening it shares: a message published in one reaches the members connected to the others as the file changes, and at worst within `poll`, `'250ms'` by default (`'25ms'` where the file cannot be watched); a bare number throws.
// A process that stops without leaving, such as one that crashed, has its members dropped once it has not been heard from for 10 seconds; one that was only stalled that long writes its members back once it runs again.
// The file is opened by the first call that needs it, so loading a config that names it, to build or check, creates nothing.
export function sqliteRooms(path: string, { poll }: { poll?: Duration } = {}): RoomStore {
  const askedMs = poll === undefined ? undefined : optionMs(poll, '`sqliteRooms` poll')
  let opened: RoomStore | undefined
  let closed = false
  const open = (): RoomStore => {
    if (closed)
      throw new Error('kay: the rooms store was closed')

    return opened ??= openRooms(path, askedMs)
  }

  // A reload closes the file for the module that named the store, whichever module first used it; the module running again names a store of its own.
  onReload(() => opened?.close())

  return {
    add: (room, connection, member) => open().add(room, connection, member),
    remove: (room, connection) => open().remove(room, connection),
    members: room => open().members(room),
    state: room => open().state!(room),
    update: (room, change) => open().update!(room, change),
    publish: (room, text, recipients) => open().publish(room, text, recipients),
    subscribe: listener => open().subscribe(listener),
    close: () => {
      closed = true
      opened?.close()
    },
  }
}

function openRooms(path: string, askedMs: number | undefined): RoomStore {
  const db = openSqlite(path)
  const self = crypto.randomUUID()

  db.run('CREATE TABLE IF NOT EXISTS kay_room_members (room TEXT NOT NULL, connection TEXT NOT NULL, process TEXT NOT NULL, member TEXT NOT NULL, PRIMARY KEY (room, connection))')
  db.run('CREATE TABLE IF NOT EXISTS kay_room_processes (process TEXT PRIMARY KEY, seen INTEGER NOT NULL)')
  db.run('CREATE TABLE IF NOT EXISTS kay_room_state (room TEXT PRIMARY KEY, state TEXT NOT NULL)')
  db.run('CREATE TABLE IF NOT EXISTS kay_room_messages (id INTEGER PRIMARY KEY AUTOINCREMENT, room TEXT NOT NULL, text TEXT NOT NULL, process TEXT NOT NULL, skipped TEXT, recipient TEXT, at INTEGER NOT NULL)')
  // The beat deletes the dead processes' members and the old messages by these.
  db.run('CREATE INDEX IF NOT EXISTS kay_room_members_process ON kay_room_members (process)')
  db.run('CREATE INDEX IF NOT EXISTS kay_room_messages_at ON kay_room_messages (at)')

  // An upsert, so a member joining again keeps its place in the list, as it does in memory.
  const add = db.query('INSERT INTO kay_room_members (room, connection, process, member) VALUES (?, ?, ?, ?) ON CONFLICT (room, connection) DO UPDATE SET member = excluded.member')
  const remove = db.query('DELETE FROM kay_room_members WHERE room = ? AND connection = ?')
  const kept = db.query<{ state: string }, [string]>('SELECT state FROM kay_room_state WHERE room = ?')
  const keep = db.query('INSERT OR REPLACE INTO kay_room_state (room, state) VALUES (?, ?)')
  const occupied = db.query<{ present: number }, [string, number]>('SELECT 1 AS present WHERE EXISTS (SELECT 1 FROM kay_room_members JOIN kay_room_processes USING (process) WHERE room = ? AND seen > ?)')
  // A room's state goes once no live process has a member in it.
  const drop = db.query('DELETE FROM kay_room_state WHERE room = ? AND NOT EXISTS (SELECT 1 FROM kay_room_members JOIN kay_room_processes USING (process) WHERE room = ? AND seen > ?)')
  const members = db.query<{ member: string }, [string, number]>('SELECT member FROM kay_room_members JOIN kay_room_processes USING (process) WHERE room = ? AND seen > ? ORDER BY kay_room_members.rowid')
  const insert = db.query('INSERT INTO kay_room_messages (room, text, process, skipped, recipient, at) VALUES (?, ?, ?, ?, ?, ?)')
  const since = db.query<{ id: number, room: string, text: string, skipped: string | null, recipient: string | null }, [number, string]>('SELECT id, room, text, skipped, recipient FROM kay_room_messages WHERE id > ? AND process != ? ORDER BY id')
  const latest = db.query<{ id: number | null }, []>('SELECT max(id) AS id FROM kay_room_messages')
  const known = db.query<{ seen: number }, [string]>('SELECT seen FROM kay_room_processes WHERE process = ?')
  const heartbeat = db.query('INSERT OR REPLACE INTO kay_room_processes (process, seen) VALUES (?, ?)')
  const listeners = new Set<RoomListener>()
  // This process's members, written back should the others have dropped them while it was stalled.
  const own = new Map<string, { room: string, connection: string, member: string }>()
  let last = 0
  let reading: ReturnType<typeof setInterval> | undefined
  let watcher: FSWatcher | undefined
  let woken: ReturnType<typeof setTimeout> | undefined
  let closed = false
  let beating: ReturnType<typeof setInterval> | undefined
  let pruned = 0

  // Drops the members of processes gone quiet and the messages past `KEPT`.
  // One transaction, so a process beating between two of the deletes never finds its row kept while its members went.
  const prune = db.transaction((now: number) => {
    const emptied = db.query<{ room: string }, [number]>('SELECT DISTINCT room FROM kay_room_members WHERE process IN (SELECT process FROM kay_room_processes WHERE seen <= ?)').all(now - EXPIRY)

    db.run('DELETE FROM kay_room_members WHERE process IN (SELECT process FROM kay_room_processes WHERE seen <= ?)', [now - EXPIRY])
    db.run('DELETE FROM kay_room_processes WHERE seen <= ?', [now - EXPIRY])

    for (const { room } of emptied)
      drop.run(room, room, now - EXPIRY)

    db.run('DELETE FROM kay_room_messages WHERE at <= ?', [now - KEPT])
  })

  const beat = () => {
    const now = Date.now()

    db.transaction(() => {
      const dropped = known.get(self) === null

      heartbeat.run(self, now)

      if (dropped) {
        for (const { room, connection, member } of own.values())
          add.run(room, connection, self, member)
      }

      prune(now)
    }).immediate()
  }

  const read = () => {
    for (const row of since.all(last, self)) {
      last = row.id

      for (const listener of listeners)
        listener(row.room, row.text, { ...row.skipped !== null && { except: row.skipped }, ...row.recipient !== null && { to: row.recipient } })
    }
  }

  const stopReading = () => {
    clearInterval(reading)
    clearTimeout(woken)
    watcher?.close()
    reading = undefined
    woken = undefined
    watcher = undefined
  }

  // The process says it is alive, and reads what others publish, only while it holds a connection: one with none has no member to keep or to deliver to.
  const sync = () => {
    const held = own.size > 0 && !closed

    if (held && !beating) {
      beat()
      beating = setInterval(guarded('marking this process alive in the rooms store', beat), HEARTBEAT)
      beating.unref()
    }
    else if (!held && beating) {
      clearInterval(beating)
      beating = undefined
    }

    if (held && listeners.size > 0 && !reading) {
      // Read from now on: what others published before anyone here listened is for the members they had then.
      last = latest.get()?.id ?? 0

      const reader = guarded('reading what other processes published to rooms', read)

      const readEvery = (ms: number) => {
        if (reading)
          clearInterval(reading)

        reading = setInterval(reader, ms)
        reading.unref()
      }

      watcher = watchStore(path, () => {
        // Several writes of one transaction wake it once.
        woken ??= setTimeout(() => {
          woken = undefined
          reader()
        }, 0)
      }, () => {
        // A watcher failing later leaves the interval the only read, so it goes back to the short one.
        if (reading)
          readEvery(askedMs ?? UNWATCHED_POLL_MS)
      })
      readEvery(askedMs ?? (watcher ? WATCHED_POLL_MS : UNWATCHED_POLL_MS))
    }
    else if (!(held && listeners.size > 0) && reading) {
      stopReading()
    }
  }

  const store: RoomStore = {
    add(room, connection, member) {
      own.set(`${room}\n${connection}`, { room, connection, member })
      sync()
      add.run(room, connection, self, member)
    },
    remove(room, connection) {
      own.delete(`${room}\n${connection}`)
      db.transaction(() => {
        remove.run(room, connection)
        drop.run(room, room, Date.now() - EXPIRY)
      }).immediate()
      sync()
    },
    state: room => kept.get(room)?.state,
    // Immediate, so two processes changing one room's state wait for each other rather than both reading the old one.
    update: (room, change) => db.transaction(() => {
      const next = change(kept.get(room)?.state)

      // A room no live process has a member in keeps nothing, so a room named by a client costs no row.
      if (occupied.get(room, Date.now() - EXPIRY) !== null)
        keep.run(room, next)

      return next
    }).immediate(),
    members: room => members.all(room, Date.now() - EXPIRY).map(row => row.member),
    publish(room, text, recipients) {
      const now = Date.now()

      insert.run(room, text, self, recipients.except ?? null, recipients.to ?? null, now)

      for (const listener of listeners)
        listener(room, text, recipients)

      // A process only publishing has no beat, so its publishes prune, as often as a beat would; the message is stored and delivered by now, so a failing prune is only logged.
      if (!beating && now - pruned >= HEARTBEAT) {
        pruned = now
        guarded('pruning the rooms store', () => prune.immediate(now))()
      }
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
      closed = true
      clearInterval(beating)
      stopReading()
      beating = undefined
      listeners.clear()
      db.close()
    },
  }

  return store
}

// Calls `wake` when a process writes the SQLite file or the WAL beside it, or undefined where it cannot be watched: memory, or a folder the platform will not watch.
function watchStore(path: string, wake: () => void, failed: () => void): FSWatcher | undefined {
  if (path === ':memory:' || path === '')
    return undefined

  const name = basename(path)

  try {
    const watcher = watch(dirname(path), { persistent: false }, (_, changed) => {
      if (changed === null || changed.startsWith(name))
        wake()
    })

    // A watcher that fails leaves the interval the only read.
    watcher.on('error', () => {
      watcher.close()
      failed()
    })

    return watcher
  }
  catch {
    return undefined
  }
}
