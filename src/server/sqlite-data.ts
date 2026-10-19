import type { AppStore } from './app-store'
import { sqliteRates } from './protection'
import { sqliteJobs } from './queue'

// Jobs and rate counts in one SQLite file, shared by every process of the machine opening it.
// Both open the file on first use, so loading the config to build or check creates nothing.
export function sqliteData(path: string): Required<AppStore> {
  const rates = sqliteRates(path)

  return {
    jobs: sqliteJobs(path),
    rates: {
      hit: async (key, windowMs, weight) => rates.hit(key, windowMs, weight),
      peek: async key => rates.peek!(key),
    },
  }
}
