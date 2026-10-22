import type { SQL } from 'bun'
import type { AppStore } from './app-store'
import type { PgJobsSource } from './pg-jobs'
import type { SessionStore } from './session'
import { pgCache } from './pg-cache'
import { connectionOf, createJobTables, jobTables, pgJobs, rowsOf } from './pg-jobs'
import { pgRooms } from './pg-rooms'
import { pgRates, pgSessions, pgVitals } from './pg-stores'
import { onReload } from './reload'

// What replicas starting together take turns on while one creates the tables.
const MIGRATION_LOCK = 'kay_data'
const INSUFFICIENT_PRIVILEGE = '42501'

// The tables `pgData` creates besides the jobs' ones.
const OWN_TABLES = ['kay_sessions', 'kay_cache', 'kay_events', 'kay_rates', 'kay_meta', 'kay_vitals', 'kay_room_members', 'kay_room_processes', 'kay_room_messages', 'kay_room_state'] as const

// The names of the tables `pgData` keeps its data in, the jobs' included, for a pg-orm `ignoreTables` of an app that creates them with `createDataTables`.
export const dataTables = [...jobTables, ...OWN_TABLES] as readonly string[]

// What a Postgres store reaches its database through: the connection, once the tables are in place.
export interface PgHandle {
  db: () => Promise<SQL>
}

// Creates every table `pgData` keeps its data in, the jobs' included, unless they exist, for an app whose migrations do not: run it as the database's owner, in a boot script, when the app connects with a role that creates nothing. `pgData` creates them itself when its role may.
// Replicas running it together take turns, and tables already there are left alone.
export async function createDataTables(source: PgJobsSource): Promise<void> {
  const db = connectionOf(source)

  try {
    await createJobTables(db)
    await db.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtext(${MIGRATION_LOCK}))`
      await tx`CREATE TABLE IF NOT EXISTS kay_sessions (id text PRIMARY KEY, data text NOT NULL, expires bigint NOT NULL)`
      await tx`CREATE INDEX IF NOT EXISTS kay_sessions_expires ON kay_sessions (expires)`
      await tx`CREATE TABLE IF NOT EXISTS kay_cache (key text PRIMARY KEY, value text NOT NULL, fresh_until bigint NOT NULL, reads text)`
      await tx`CREATE TABLE IF NOT EXISTS kay_events (id bigserial PRIMARY KEY, origin text NOT NULL, message text NOT NULL, at bigint NOT NULL)`
      await tx`CREATE INDEX IF NOT EXISTS kay_events_at ON kay_events (at)`
      await tx`CREATE TABLE IF NOT EXISTS kay_rates (key text PRIMARY KEY, count integer NOT NULL, reset_at bigint NOT NULL)`
      await tx`CREATE INDEX IF NOT EXISTS kay_rates_reset ON kay_rates (reset_at)`
      await tx`CREATE TABLE IF NOT EXISTS kay_meta (name text PRIMARY KEY, value text NOT NULL)`
      await tx`CREATE TABLE IF NOT EXISTS kay_vitals (day integer NOT NULL, route text NOT NULL, vital text NOT NULL, bucket integer NOT NULL, count bigint NOT NULL, PRIMARY KEY (day, route, vital, bucket))`
      await tx`CREATE TABLE IF NOT EXISTS kay_room_members (room text NOT NULL, connection text NOT NULL, process text NOT NULL, member text NOT NULL, at bigint NOT NULL, PRIMARY KEY (room, connection))`
      await tx`CREATE INDEX IF NOT EXISTS kay_room_members_process ON kay_room_members (process)`
      await tx`CREATE TABLE IF NOT EXISTS kay_room_processes (process text PRIMARY KEY, seen bigint NOT NULL)`
      await tx`CREATE TABLE IF NOT EXISTS kay_room_messages (id bigserial PRIMARY KEY, room text NOT NULL, text text NOT NULL, process text NOT NULL, skipped text, recipient text, at bigint NOT NULL)`
      await tx`CREATE INDEX IF NOT EXISTS kay_room_messages_at ON kay_room_messages (at)`
      await tx`CREATE TABLE IF NOT EXISTS kay_room_state (room text PRIMARY KEY, state text NOT NULL)`
    })
  }
  finally {
    if (typeof source === 'string')
      await db.close()
  }
}

// One connection and one table check for every store of a `pgData`.
export function pgHandle(db: SQL): PgHandle {
  let ready: Promise<SQL> | undefined

  const create = async (): Promise<SQL> => {
    const [found] = await rowsOf<{ missing: boolean }>(db.unsafe(`SELECT ${OWN_TABLES.map(name => `to_regclass('${name}') IS NULL`).join(' OR ')} AS missing`))

    if (found?.missing !== true)
      return db

    try {
      await createDataTables(db)
    }
    catch (error) {
      if ((error as { errno?: string }).errno === INSUFFICIENT_PRIVILEGE)
        throw new Error('kay: pgData needs its kay_* tables, and its role may not create them: run `await createDataTables(db)` from kay/server as the database\'s owner, and list `dataTables` from kay/server in pg-orm\'s `ignoreTables`', { cause: error })

      throw error
    }

    return db
  }

  // A failed creation is tried again by the next call rather than kept.
  return { db: async () => {
    ready ??= create()

    try {
      return await ready
    }
    catch (error) {
      ready = undefined

      throw error
    }
  } }
}

// Sessions, cached values, jobs, rate counts, the members of presence rooms and the Web Vitals visitors reported in the app's Postgres, shared by every process of every replica opening it: `store: pgData(db)` in kay.config.ts, `db` a Bun `SQL`, a pg-orm `Database` or a connection URL as `pgJobs` takes.
// The `kay_*` tables are created when missing, which takes a role that may create tables: with one that may not, `createDataTables` run by the owner makes them. Replicas hear each other's invalidations and room messages by polling, within about half a second, so nothing needs LISTEN and a pooler in front of Postgres is fine.
// A room's state is kept there too, so `rooms({ state, store: pgData(db).rooms })` answers `state` and `update` with promises.
export function pgData(source: PgJobsSource) {
  const db = connectionOf(source)

  // A connection opened from a URL goes with the module that opened it, so a reload does not leave its pool behind.
  if (typeof source === 'string')
    onReload(() => void db.close())

  const handle = pgHandle(db)

  // Live values stay in the process until Postgres keeps them too: kaynooo/kayjs#1873.
  return { sessions: pgSessions(handle), cache: pgCache(handle), jobs: pgJobs(db), rates: pgRates(handle), rooms: pgRooms(handle), vitals: pgVitals(handle) } satisfies { [Kind in Exclude<keyof AppStore, 'live'>]-?: NonNullable<AppStore[Kind]> } & { sessions: SessionStore & { deleteWhere: NonNullable<SessionStore['deleteWhere']> } }
}
