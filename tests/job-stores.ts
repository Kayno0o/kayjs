// The job stores a test runs a case against, and the Postgres they take: one list for the store contract and the queue on top of it.
import type { JobStore } from '../src/server'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { SQL } from 'bun'
import { afterAll, describe, it } from 'bun:test'
import { memoryJobs, pgJobs, sqliteJobs } from '../src/server'

// A Postgres whose user may create databases, as the app template's tests take: CI sets it.
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? ''

export const url = TEST_DATABASE_URL === '' ? undefined : new URL(TEST_DATABASE_URL)
let database = ''
let databases = 0

// Without a database the Postgres cases skip, and CI, which sets CI, fails instead.
export const pgIt = it.skipIf(url === undefined && (process.env.CI ?? '') === '')
export const pgDescribe = describe.skipIf(url === undefined && (process.env.CI ?? '') === '')
let databaseUrl: string | undefined
let shared: SQL | undefined
const clients: SQL[] = []

// A database of its own, so another test file's Postgres cases never share its tables.
export async function postgres(): Promise<{ sql: SQL, url: string }> {
  if (databaseUrl === undefined) {
    database = `kay_job_store_${process.pid}_${++databases}`

    const admin = new SQL(Object.assign(new URL(url!.href), { pathname: '/postgres' }).href)

    await admin.unsafe(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`)
    await admin.unsafe(`CREATE DATABASE ${database}`)
    await admin.close()
    databaseUrl = Object.assign(new URL(url!.href), { pathname: `/${database}` }).href
  }

  shared ??= new SQL(databaseUrl, { max: 3 })
  clients.push(shared)

  return { sql: shared, url: databaseUrl }
}

// Separate connections, as replicas of an app have.
export function replicas(count: number): SQL[] {
  return Array.from({ length: count }, () => {
    const sql = new SQL(databaseUrl!, { max: 2 })

    clients.push(sql)

    return sql
  })
}

// Tables dropped first, so each case starts on an empty store.
export async function freshPg(): Promise<SQL> {
  const { sql } = await postgres()

  await sql.unsafe('DROP TABLE IF EXISTS kay_jobs, kay_locks')

  return sql
}

const dirs: string[] = []

// Called at the top of a test file that takes these stores: its scratch files and its database go with it, so two files in one process never share them.
export function cleanUpAfterFile(): void {
  // DROP DATABASE waits for a checkpoint, which queues behind every other file's on a loaded host (CI shares it with landings): past Bun's 20 s hook default, so the hook has a minute.
  afterAll(async () => {
    await Promise.all(dirs.splice(0).map(async dir => rm(dir, { recursive: true, force: true })))
    // Each client closed once, its queries given two seconds; a connection the server killed never settles its close (Bun 1.4), so it is left after three.
    await Promise.all([...new Set(clients.splice(0))].map(async client => Promise.race([client.close({ timeout: 2 }), Bun.sleep(3000)])))

    if (databaseUrl !== undefined) {
      const admin = new SQL(Object.assign(new URL(url!.href), { pathname: '/postgres' }).href)

      await admin.unsafe(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`)
      await Promise.race([admin.close({ timeout: 2 }), Bun.sleep(3000)])
      databaseUrl = undefined
      shared = undefined
    }
  }, 60_000)
}

export async function sqlitePath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'kay-job-store-'))

  dirs.push(dir)

  return join(dir, 'jobs.sqlite')
}

export interface Kind { name: string, open: () => JobStore | Promise<JobStore> }

// The stores that share one contract: every case below runs against each.
export const kinds: Kind[] = [
  { name: 'memory', open: () => memoryJobs() },
  { name: 'sqlite', open: async () => sqliteJobs(await sqlitePath()) },
  ...url === undefined && (process.env.CI ?? '') === '' ? [] : [{ name: 'postgres', open: async () => pgJobs(await freshPg()) }],
]
