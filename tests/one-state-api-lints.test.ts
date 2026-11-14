import { join } from 'node:path'
import { expect, it } from 'bun:test'

import { applySafeFixes } from '../src/check/fixes'
import { listenTarget, movedImports, navigateQuery, navigationHooks, persistedCall, persistedQuery } from '../src/check/one-state-api'
import { scratchDir } from './scratch'

type Check = typeof persistedCall

// Runs `check` over a module holding `source`, applies its safe fixes and returns what the module reads afterwards with the diagnostics' count.
async function fixed(check: Check, source: string): Promise<{ text: string, found: number, fixable: number }> {
  const root = await scratchDir('one-state-api-')
  const file = join(root, 'src/mod.ts')

  await Bun.write(file, source)

  const found = await check(root, {})

  await applySafeFixes(root, found)

  return { text: await Bun.file(file).text(), found: found.length, fixable: found.filter(one => one.fixes?.some(fix => fix.safe)).length }
}

it('rewrites persisted.query to queryParam with its default, values and history', async () => {
  const { text } = await fixed(persistedQuery, `import { persisted } from 'kay'\nconst tab = persisted.query('tab', 'a', { values: ['a', 'b'], history: 'push' })\n`)

  expect(text).toBe(`import { queryParam } from 'kay'\nconst tab = queryParam('tab', { default: 'a', values: ['a', 'b'], history: 'push' })\n`)
})

it('keeps persisted imported while another call still reads it', async () => {
  const { text } = await fixed(persistedQuery, `import { persisted } from 'kay'\nconst a = persisted.query('a', '')\nconst b = persisted.local('b', 0)\n`)

  expect(text).toContain(`import { persisted, queryParam } from 'kay'`)
  expect(text).toContain(`queryParam('a', { default: '' })`)
})

it('rewrites a call through a namespace import', async () => {
  const { text } = await fixed(persistedQuery, `import * as kay from 'kay'\nconst a = kay.persisted.query('a', '')\n`)

  expect(text).toContain(`kay.queryParam('a', { default: '' })`)
})

it('leaves a persisted of another package alone', async () => {
  const { found } = await fixed(persistedQuery, `import { persisted } from './mine'\nconst a = persisted.query('a', '')\n`)

  expect(found).toBe(0)
})

it('names a bare persisted call a cookie, and reports one passing storage with no fix', async () => {
  const bare = await fixed(persistedCall, `import { persisted } from 'kay'\nconst a = persisted('a', 1)\n`)

  expect(bare.text).toContain(`persisted.cookie('a', 1)`)

  const storage = await fixed(persistedCall, `import { persisted } from 'kay'\nconst a = persisted('a', 1, { storage: 'local' })\n`)

  expect(storage.found).toBe(1)
  expect(storage.fixable).toBe(0)
  expect(storage.text).toContain(`storage: 'local'`)
})

it('rewrites navigate({ query }) to navigate.query, and not a call with other members', async () => {
  const { text } = await fixed(navigateQuery, `import { navigate } from 'kay'\nawait navigate({ query: { page: 2 } }, { replace: true })\n`)

  expect(text).toContain(`navigate.query({ page: 2 }, { replace: true })`)

  const other = await fixed(navigateQuery, `import { navigate } from 'kay'\nawait navigate({ query: { page: 2 }, extra: 1 })\n`)

  expect(other.fixable).toBe(0)
})

it('moves the navigation hooks onto navigation', async () => {
  const { text } = await fixed(navigationHooks, `import { onNavigate } from 'kay'\nonNavigate(({ url }) => url)\n`)

  expect(text).toContain(`navigation.onNavigate(`)
  expect(text).toContain(`import { navigation } from 'kay'`)
})

it('wraps a bare listen target in a function', async () => {
  const { text } = await fixed(listenTarget, `import { listen } from 'kay'\nlisten(window, 'resize', () => 1)\n`)

  expect(text).toContain(`listen(() => window, 'resize'`)
})

it('moves an import from kay/mount and kay/server to its home', async () => {
  const { text } = await fixed(movedImports, `import { mount } from 'kay/mount'\nimport { sqliteCache } from 'kay/server'\n`)

  expect(text).toContain(`from 'kay'`)
  expect(text).toContain(`from 'kay/cache'`)
  expect(text).not.toContain('kay/mount')
})
