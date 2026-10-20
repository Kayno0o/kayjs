import type { AppStore } from './app-store'
import { sqliteRates } from './protection'
import { sqliteJobs } from './queue'
import { sqliteRooms } from './rooms'

// Jobs, rate counts and the members of presence rooms in one SQLite file, shared by every process of the machine opening it.
// Each opens the file on first use, so loading the config to build or check creates nothing.
export function sqliteData(path: string): Required<AppStore> {
  return { jobs: sqliteJobs(path), rates: sqliteRates(path), rooms: sqliteRooms(path) }
}
