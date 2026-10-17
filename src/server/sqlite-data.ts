import type { RateStore } from '../runtime/action'
import type { AppStore } from './app-store'
import { sqliteRates } from './protection'
import { sqliteJobs } from './queue'

// Jobs and rate counts in one SQLite file, shared by every process of the machine opening it.
// The rate counts open the file on the first hit, as the jobs do on the first job, so loading the config to build or check creates nothing.
export function sqliteData(path: string): Required<AppStore> {
  let rates: RateStore | undefined
  const opened = (): RateStore => rates ??= sqliteRates(path)

  return {
    jobs: sqliteJobs(path),
    rates: {
      hit: async (key, windowMs, weight) => opened().hit(key, windowMs, weight),
      peek: async key => opened().peek!(key),
    },
  }
}
