import { existsSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'
import { afterEach, expect, setSystemTime, test } from 'bun:test'
import { memoryAuth } from '../src/memoryStore'
import { PRUNE_EVERY_MS } from '../src/prune'
import { testApp } from './helpers/app'

afterEach(() => {
  setSystemTime()
})

// The prune is a maintenance, which in production takes a lock in the app's job store; an app without one must not get kay's default sqlite store written into its folder.
test('a prune in production creates no job store in the package folder', async () => {
  const before = process.env.NODE_ENV
  const { browser, pruned } = testApp({ store: memoryAuth() })

  process.env.NODE_ENV = 'production'

  try {
    setSystemTime(Date.now() + PRUNE_EVERY_MS)
    await browser().json('/me')
    await pruned()
  }
  finally {
    if (before === undefined)
      delete process.env.NODE_ENV
    else
      process.env.NODE_ENV = before
  }

  expect(existsSync(join(import.meta.dir, '../data'))).toBe(false)
})
