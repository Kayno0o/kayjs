import type { StoreBase } from '../runtime/store-base'
import type { AppStore } from './app-store'
import { dirname, join, resolve } from 'node:path'
import { sqliteCache } from '../runtime/cache.server'
import { sqliteNotifications } from './notifications'
import { sqliteRates } from './protection'
import { sqlitePush } from './push-store'
import { sqliteJobs } from './queue'
import { sqliteRooms } from './rooms'
import { sqliteSessions } from './session'
import { sqliteLive } from './sqlite-live'
import { diskFiles, memoryFiles } from './storage'
import { sqliteVitals } from './vitals-store'

// Sessions, cached values, live values, jobs, rate counts, the members of presence rooms and the Web Vitals visitors reported and the notifications of a person in one SQLite file, shared by every process of the machine opening it, and the files `files` stores in a `files` folder beside it: `data/files` for `data/app.sqlite`, where files go by default.
// Each opens the file on first use, so loading the config to build or check creates no file. `sessions` keeps `deleteWhere`, for ending a person's sessions.
export function sqliteData(path: string) {
  const onDisk = path !== '' && path !== ':memory:'

  return { sessions: sqliteSessions(path), cache: sqliteCache(path), jobs: sqliteJobs(path), rates: sqliteRates(path), live: sqliteLive(path), rooms: sqliteRooms(path), vitals: sqliteVitals(path), ...onDisk && { database: `sqlite://${resolve(path)}` }, notifications: sqliteNotifications(path), push: sqlitePush(path), files: onDisk ? diskFiles(join(dirname(path), 'files')) : memoryFiles() } satisfies { [Kind in Exclude<keyof AppStore, 'database' | keyof StoreBase>]-?: NonNullable<AppStore[Kind]> }
}
