import type { AppStore } from './app-store'
import { sqliteRates } from './protection'
import { sqliteJobs } from './queue'
import { sqliteRooms } from './rooms'
import { sqliteVitals } from './vitals-store'

// Jobs, rate counts, the members of presence rooms and the Web Vitals visitors reported in one SQLite file, shared by every process of the machine opening it.
// Each opens the file on first use, so loading the config to build or check creates nothing.
export function sqliteData(path: string): { [Kind in keyof AppStore]-?: NonNullable<AppStore[Kind]> } {
  return { jobs: sqliteJobs(path), rates: sqliteRates(path), rooms: sqliteRooms(path), vitals: sqliteVitals(path) }
}
