import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it } from 'bun:test'

// The commands that run the app, or reload a config in a session that stays, wait for it as long as it takes.
const WAITING = new Set(['start.ts', 'render.ts', 'check.ts'])

it('has every command that ends by itself load the config within a time limit', async () => {
  const dir = join(import.meta.dir, '../src/commands')
  const unlimited: string[] = []

  for (const file of readdirSync(dir).filter(name => name.endsWith('.ts') && !WAITING.has(name))) {
    if ((/\bloadConfig\(/).test(await Bun.file(join(dir, file)).text()))
      unlimited.push(file)
  }

  expect(unlimited).toEqual([])
})
