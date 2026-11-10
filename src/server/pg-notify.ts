import type { SQL } from 'bun'
import { kayLog } from '../runtime/log'
import { outsideRequest } from './clean-context'
import { isServing, onServingChange } from './serving'

// The one channel every kay store of a database uses; a payload names what changed, `kind` or `kind\nname`, and is only ever a reason to read the store again, never its data.
export const CHANNEL = 'kay_wake'

// How long a fresh subscription waits for its own probe to come back before it is taken as one that delivers nothing, as behind a pooler in transaction mode.
const PROBE_MS = 3000
// How long after a failed subscription (the database down, `LISTEN` refused) the next try comes.
const RETRY_MS = 30_000
// A name longer than this is left out of the payload, which then wakes every reader of its kind.
const MAX_NAME = 200
const PROBE = 'probe\n'

export interface Subscription {
  // Ends it; the connection closes with the last one of its database.
  stop: () => Promise<void>
  // Whether notifications are known to arrive, which lets a reader poll less often.
  delivering: () => boolean
}

interface Reader {
  kind: string
  name: string | undefined
  wake: () => void
}

// The arguments of the `pg_notify` a write sends in its own transaction or statement, delivered on commit.
export function wakeOf(kind: string, name?: string): [channel: string, payload: string] {
  return [CHANNEL, name === undefined || name.length > MAX_NAME ? kind : `${kind}\n${name}`]
}

class Notifier {
  readonly #db: SQL
  readonly #readers = new Set<Reader>()
  #registration: { unlisten: () => Promise<void> } | undefined
  #opening: Promise<void> | undefined
  #retry: ReturnType<typeof setTimeout> | undefined
  #probe: string | undefined
  #listened = 0
  #delivering = false
  #said = false
  #unwatch: (() => void) | undefined

  constructor(db: SQL) {
    this.#db = db
  }

  delivering = (): boolean => this.#delivering

  async subscribe(kind: string, name: string | undefined, wake: () => void): Promise<Subscription> {
    const reader: Reader = { kind, name, wake }

    this.#readers.add(reader)
    // Opened while a server runs here and closed when the last one stops: the connection keeps a process alive, which a script using a store must not wait on.
    this.#unwatch ??= onServingChange(() => void (isServing() ? this.#open() : this.#close()))
    await this.#open()

    return {
      delivering: this.delivering,
      stop: async () => {
        if (!this.#readers.delete(reader) || this.#readers.size > 0)
          return

        this.#unwatch?.()
        this.#unwatch = undefined
        await this.#close()
      },
    }
  }

  // One subscription of the database for every reader, opened by the first.
  async #open(): Promise<void> {
    if (!isServing())
      return

    const opening = this.#opening ??= this.#listen()

    try {
      await opening
    }
    finally {
      if (this.#opening === opening)
        this.#opening = undefined
    }
  }

  async #listen(): Promise<void> {
    if (this.#registration !== undefined)
      return

    try {
      const registration = await outsideRequest(async () => this.#db.listen(CHANNEL, payload => this.#heard(payload), () => this.#listened++ === 0 ? this.#probeIt() : this.#caughtUp()))

      // Every reader left while it connected.
      if (this.#readers.size === 0)
        await registration.unlisten()
      else
        this.#registration = registration
    }
    catch (error) {
      this.#failed('could not listen for the writes of the other processes', error)
    }
  }

  #failed(why: string, error?: unknown): void {
    // One line for the whole run: a database down for an hour is not logged at every retry.
    if (!this.#said) {
      this.#said = true
      kayLog('warn', `kay: Postgres ${why}, so processes hear each other's writes by polling only`, error)
    }

    if (this.#retry !== undefined || this.#readers.size === 0)
      return

    this.#retry = setTimeout(() => {
      this.#retry = undefined

      if (this.#readers.size > 0 && this.#registration === undefined)
        void this.#open()
    }, RETRY_MS)
    this.#retry.unref()
  }

  // A notification sent through this database that must come back, or the subscription is one that never delivers.
  #probeIt(): void {
    const probe = crypto.randomUUID()

    this.#probe = probe

    const timer = setTimeout(() => {
      if (this.#probe === probe && !this.#delivering)
        this.#failed('accepted LISTEN but delivered no notification (a pooler in transaction mode?)')
    }, PROBE_MS)

    timer.unref()
    void (async () => {
      try {
        await this.#db`SELECT pg_notify(${CHANNEL}, ${PROBE + probe})`
      }
      catch (error) {
        this.#failed('could not send a notification', error)
      }
    })()
  }

  // Back after a reconnect: whatever was written while the connection was down is read now.
  #caughtUp(): void {
    for (const reader of this.#readers)
      reader.wake()
  }

  #heard(payload: string): void {
    if (payload.startsWith(PROBE)) {
      if (payload === PROBE + this.#probe)
        this.#delivering = true

      return
    }

    const at = payload.indexOf('\n')
    const kind = at < 0 ? payload : payload.slice(0, at)
    const name = at < 0 ? undefined : payload.slice(at + 1)

    for (const reader of this.#readers) {
      if (reader.kind === kind && (name === undefined || reader.name === undefined || reader.name === name))
        reader.wake()
    }
  }

  async #close(): Promise<void> {
    clearTimeout(this.#retry)
    this.#retry = undefined
    await this.#opening

    const registration = this.#registration

    this.#registration = undefined
    this.#delivering = false
    this.#probe = undefined
    this.#listened = 0

    try {
      await registration?.unlisten()
    }
    catch {
      // The connection went with its pool.
    }
  }
}

const notifiers = new WeakMap<SQL, Notifier>()

// Listens, on `db`, for the writes of the other processes naming `kind` (and `name`, when given), calling `wake` for each and once more when the subscription is back after a reconnect. Never rejects: a database that refuses LISTEN or delivers nothing leaves a subscription that is not `delivering`, and the reader polls as before.
export async function hear(db: SQL, kind: string, name: string | undefined, wake: () => void): Promise<Subscription> {
  let notifier = notifiers.get(db)

  if (notifier === undefined) {
    notifier = new Notifier(db)
    notifiers.set(db, notifier)
  }

  return notifier.subscribe(kind, name, wake)
}
