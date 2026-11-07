import { rm } from 'node:fs/promises'
import { afterAll } from 'bun:test'

// The directories this process made through `scratchDir`, removed once its tests ran: a test that skips its own `rm` leaves nothing behind. A preload, so the hook runs once at the end of the process, whatever files it ran.
export const made = new Set<string>()

afterAll(async () => {
  await Promise.all([...made].map(async dir => rm(dir, { recursive: true, force: true })))
  made.clear()
})
