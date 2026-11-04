import type { SQL } from 'bun'
import { appStore } from './app-store'

// The database the app's `store` keeps its data in, which a library keeping tables of its own defaults to: a SQLite file by its absolute path, or Postgres by the connection `pgData` works through (so a library opens no pool of its own), else the url the store names. Nothing when the store names none (a store built by hand) or the app has no store.
export type AppDatabase = { kind: 'sqlite', path: string } | { kind: 'pg', source: SQL | string }

const SQLITE_URL = /^sqlite:\/\/(\/.+)$/

export function appDatabase(): AppDatabase | undefined {
  const store = appStore()
  const url = store?.database

  if (store?.sql !== undefined)
    return { kind: 'pg', source: store.sql }

  if (url === undefined || url === '')
    return undefined

  const file = SQLITE_URL.exec(url)?.[1]

  return file === undefined ? { kind: 'pg', source: url } : { kind: 'sqlite', path: file }
}
