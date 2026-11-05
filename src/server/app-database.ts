import type { SQL } from 'bun'
import type { AppStore } from './app-store'
import { appStore } from './app-store'

// The database the app's `store` keeps its data in, which a library keeping tables of its own defaults to: a SQLite file by its absolute path, or Postgres by the connection `pgData` works through (so a library opens no pool of its own), else the url the store names. Nothing when the store names none (a store built by hand) or the app has no store.
export type AppDatabase = { kind: 'sqlite', path: string } | { kind: 'pg', source: SQL | string }

const SQLITE_URL = /^sqlite:\/\/(\/.+)$/

// The file a `sqlite:///abs/path` url names, undefined for any other url.
export function sqlitePath(url: string | undefined): string | undefined {
  return url === undefined ? undefined : SQLITE_URL.exec(url)?.[1]
}

export function appDatabase(): AppDatabase | undefined {
  return databaseOf(appStore())
}

// The database of a store that is not the running app's yet, as the setup reads it before it sets the store up.
export function databaseOf(store: AppStore | undefined): AppDatabase | undefined {
  const url = store?.database

  if (store?.sql !== undefined)
    return { kind: 'pg', source: store.sql }

  if (url === undefined || url === '')
    return undefined

  const file = sqlitePath(url)

  return file === undefined ? { kind: 'pg', source: url } : { kind: 'sqlite', path: file }
}
