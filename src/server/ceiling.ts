import { overLimit } from './protection'

const MINUTE_MS = 60_000

// Seconds until the next minute of a sink every visitor may reach, or undefined while the requests of all clients together stay under `max` a minute: a ceiling over the per-client limit, which a flood from many addresses never reaches.
export async function overCeiling(name: string, max: number): Promise<number | undefined> {
  return overLimit(`${name}:all`, 'all', max, MINUTE_MS)
}
