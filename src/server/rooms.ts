import { openSqlite } from '../runtime/sqlite.server'

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

// Where members and messages are kept, for one process or every process of the machine.
export interface RoomStore {
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

export interface RoomsOptions {
  // `sqliteRooms(path)` reaches every process of the machine; one process's memory by default.
  store?: RoomStore
}

export interface CoalesceOptions {
  // How long changes are gathered before the one snapshot goes, in milliseconds: 50 by default.
  wait?: number
}

export interface Rooms<Message, Member = undefined> {
  // Puts a connection in a room, with what the room lists it as; joining again changes its member.
  join: (ws: RoomConnection, room: string, ...member: undefined extends Member ? [member?: Member] : [member: Member]) => void
  // Takes a connection out of a room, or out of every room it is in, as `close` does.
  leave: (ws: RoomConnection, room?: string) => void
  // The rooms a connection of this process is in.
  roomsOf: (ws: RoomConnection) => string[]
  // The members of a room, in every process sharing the store; a room no one is in is gone, and lists none.
  members: (room: string) => Member[]
  // Sends a message to everyone in a room, but `except` when given, such as the connection it came from, or only to the connections joined as the member `to` names, such as a game's host.
  publish: (room: string, message: Message, options?: { except?: RoomConnection, to?: Member }) => void
  // A function sending a room one snapshot, read when it goes, however many times it is called within `wait`: a burst of changes goes out as one message.
  coalesce: (read: (room: string) => Message, options?: CoalesceOptions) => (room: string) => void
}

const DEFAULT_WAIT = 50
// How a connection joined without a member is written, apart from one joined as `null`, which is JSON.
const NO_MEMBER = ''
// How often a process says it is alive, and how long after its last word its members stop counting.
const HEARTBEAT = 2_000
const EXPIRY = 10_000
// How often a process reads the messages others wrote, and how long they are kept.
const POLL = 25
const KEPT = 30_000

// Rooms of websocket connections, typed by what they send: join one in `open`, leave in `close`, and publish to it from anywhere.
export function rooms<Message, Member = undefined>(options: RoomsOptions = {}): Rooms<Message, Member> {
  const store = options.store ?? memoryRooms()
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
    },
    leave(ws, room) {
      for (const name of room === undefined ? [...joined.get(ws.raw) ?? []] : [room])
        leaveOne(ws.raw, name)
    },
    roomsOf: ws => [...joined.get(ws.raw) ?? []],
    members: room => store.members(room).map(member => (member === NO_MEMBER ? undefined : JSON.parse(member)) as Member),
    publish(room, message, { except, to } = {}) {
      store.publish(room, messageText(message), { ...except && { except: idOf(except.raw) }, ...to !== undefined && { to: JSON.stringify(to) } })
    },
    coalesce(read, { wait = DEFAULT_WAIT } = {}) {
      // The rooms a snapshot is on its way to.
      const waiting = new Set<string>()

      return (room) => {
        if (waiting.has(room))
          return

        waiting.add(room)
        setTimeout(guarded(() => {
          waiting.delete(room)
          store.publish(room, messageText(read(room)), {})
        }), wait)
      }
    },
  }
}

// A message as Elysia sends one: a string as it is, anything else as JSON.
function messageText(message: unknown): string {
  return typeof message === 'string' ? message : JSON.stringify(message)
}

// What a timer runs, its error logged rather than taking the process down.
function guarded(run: () => void): () => void {
  return () => {
    try {
      run()
    }
    catch (error) {
      console.error(error)
    }
  }
}

// Rooms in this process's memory, gone when it stops.
export function memoryRooms(): RoomStore {
  const byRoom = new Map<string, Map<string, string>>()
  const listeners = new Set<RoomListener>()

  return {
    add(room, connection, member) {
      byRoom.set(room, (byRoom.get(room) ?? new Map<string, string>()).set(connection, member))
    },
    remove(room, connection) {
      const members = byRoom.get(room)

      members?.delete(connection)

      if (members?.size === 0)
        byRoom.delete(room)
    },
    members: room => [...byRoom.get(room)?.values() ?? []],
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

// Rooms kept in a SQLite file every process of the machine opening it shares: a message published in one reaches the members connected to the others, within `poll` milliseconds.
// A process that stops without leaving, such as one that crashed, has its members dropped once it has not been heard from for 10 seconds; one that was only stalled that long writes its members back once it runs again.
export function sqliteRooms(path: string, { poll = POLL }: { poll?: number } = {}): RoomStore {
  const db = openSqlite(path)
  const self = crypto.randomUUID()

  db.run('CREATE TABLE IF NOT EXISTS kay_room_members (room TEXT NOT NULL, connection TEXT NOT NULL, process TEXT NOT NULL, member TEXT NOT NULL, PRIMARY KEY (room, connection))')
  db.run('CREATE TABLE IF NOT EXISTS kay_room_processes (process TEXT PRIMARY KEY, seen INTEGER NOT NULL)')
  db.run('CREATE TABLE IF NOT EXISTS kay_room_messages (id INTEGER PRIMARY KEY AUTOINCREMENT, room TEXT NOT NULL, text TEXT NOT NULL, process TEXT NOT NULL, skipped TEXT, recipient TEXT, at INTEGER NOT NULL)')

  // An upsert, so a member joining again keeps its place in the list, as it does in memory.
  const add = db.query('INSERT INTO kay_room_members (room, connection, process, member) VALUES (?, ?, ?, ?) ON CONFLICT (room, connection) DO UPDATE SET member = excluded.member')
  const remove = db.query('DELETE FROM kay_room_members WHERE room = ? AND connection = ?')
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

  const beat = () => {
    const now = Date.now()

    db.transaction(() => {
      const dropped = known.get(self) === null

      heartbeat.run(self, now)

      if (dropped) {
        for (const { room, connection, member } of own.values())
          add.run(room, connection, self, member)
      }

      db.run('DELETE FROM kay_room_members WHERE process IN (SELECT process FROM kay_room_processes WHERE seen <= ?)', [now - EXPIRY])
      db.run('DELETE FROM kay_room_processes WHERE seen <= ?', [now - EXPIRY])
      db.run('DELETE FROM kay_room_messages WHERE at <= ?', [now - KEPT])
    })()
  }

  const read = () => {
    for (const row of since.all(last, self)) {
      last = row.id

      for (const listener of listeners)
        listener(row.room, row.text, { ...row.skipped !== null && { except: row.skipped }, ...row.recipient !== null && { to: row.recipient } })
    }
  }

  beat()

  const beating = setInterval(guarded(beat), HEARTBEAT)

  beating.unref()

  return {
    add(room, connection, member) {
      own.set(`${room}\n${connection}`, { room, connection, member })
      add.run(room, connection, self, member)
    },
    remove(room, connection) {
      own.delete(`${room}\n${connection}`)
      remove.run(room, connection)
    },
    members: room => members.all(room, Date.now() - EXPIRY).map(row => row.member),
    publish(room, text, recipients) {
      insert.run(room, text, self, recipients.except ?? null, recipients.to ?? null, Date.now())

      for (const listener of listeners)
        listener(room, text, recipients)
    },
    subscribe(listener) {
      listeners.add(listener)

      // Read from now on: what others published before anyone here listened is for the members they had then.
      if (!reading) {
        last = latest.get()?.id ?? 0
        reading = setInterval(guarded(read), poll)
        reading.unref()
      }

      return () => {
        listeners.delete(listener)

        if (listeners.size === 0) {
          clearInterval(reading)
          reading = undefined
        }
      }
    },
    close() {
      clearInterval(beating)
      clearInterval(reading)
      reading = undefined
      listeners.clear()
      db.close()
    },
  }
}
