import process from 'node:process'
import { afterEach, expect, it } from 'bun:test'
import { Elysia } from 'elysia'
import { runStopHooks } from '../src/server/lifecycle'

afterEach(() => {
  process.exitCode = 0
})

it('a hanging onStop hook is given its time, then the next one runs', async () => {
  const ran: string[] = []
  const app = new Elysia()
    .onStop(async () => new Promise<void>(() => undefined))
    .onStop(() => void ran.push('second'))

  await app.modules
  await runStopHooks(app, 50)

  expect(ran).toEqual(['second'])
  expect(process.exitCode).toBe(1)
})
