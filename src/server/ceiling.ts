import { overLimit } from './protection'

const MINUTE_MS = 60_000
// What all clients together may send one of kay's report routes a minute, so a flood from many addresses cannot fill the log and `onError`.
const ALL_REPORTS_PER_MINUTE = 600

// Seconds until the next minute of a report route every visitor may reach, or undefined while the requests of all clients together stay under the ceiling: it sits over the per-client limit, which a flood from many addresses never reaches.
export async function overCeiling(name: string): Promise<number | undefined> {
  return overLimit(`${name}:all`, 'all', ALL_REPORTS_PER_MINUTE, MINUTE_MS)
}
