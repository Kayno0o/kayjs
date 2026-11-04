import { appStore } from './app-store'

// The database the app's `store` keeps its data in, which a library keeping tables of its own defaults to: a SQLite file by its absolute path or a Postgres by its url. Nothing when the store names none (a store built by hand, `pgData` given a connection) or the app has no store.
export type AppDatabase = { kind: 'sqlite', path: string } | { kind: 'pg', url: string }

const SQLITE_URL = /^sqlite:\/\/(\/.+)$/

export function appDatabase(): AppDatabase | undefined {
  const url = appStore()?.database

  if (url === undefined || url === '')
    return undefined

  const file = SQLITE_URL.exec(url)?.[1]

  return file === undefined ? { kind: 'pg', url } : { kind: 'sqlite', path: file }
}
