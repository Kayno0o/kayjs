import type { AppStore } from './app-store'
import { sqliteCache } from '../runtime/cache.server'
import { sqliteRates } from './protection'
import { sqliteJobs } from './queue'
import { sqliteRooms } from './rooms'
import { sqliteStore } from './session'
import { sqliteVitals } from './vitals-store'

// Sessions, cached values, jobs, rate counts, the members of presence rooms and the Web Vitals visitors reported in one SQLite file, shared by every process of the machine opening it.
// Each opens the file on first use, so loading the config to build or check creates no file. `sessions` keeps `deleteWhere`, for ending a person's sessions.
export function sqliteData(path: string) {
  return { sessions: sqliteStore(path), cache: sqliteCache(path), jobs: sqliteJobs(path), rates: sqliteRates(path), rooms: sqliteRooms(path), vitals: sqliteVitals(path) } satisfies { [Kind in keyof AppStore]-?: NonNullable<AppStore[Kind]> }
}
