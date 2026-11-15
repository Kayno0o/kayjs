import { join } from 'node:path'
import { expect, it } from 'bun:test'

import { applySafeFixes } from '../src/check/fixes'
import { islandEvents, listenTarget, movedImports, navigateQuery, navigationHooks, persistedCall, persistedQuery } from '../src/check/one-state-api'
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

it('rewrites every persisted.query call of a file at once, and keeps the import it still needs', async () => {
  const { text } = await fixed(persistedQuery, `import { persisted } from 'kay'\nconst a = persisted.query('a', '')\nconst b = persisted.query('b', 1, { values: [1, 2] })\n`)

  expect(text).toBe(`import { queryParam } from 'kay'\nconst a = queryParam('a', { default: '' })\nconst b = queryParam('b', { default: 1, values: [1, 2] })\n`)
})

it('leaves a persisted.query call with equals unfixed, keeping persisted imported', async () => {
  const { text, fixable } = await fixed(persistedQuery, `import { persisted } from 'kay'\nconst a = persisted.query('a', '', { equals: false })\nconst b = persisted.query('b', '')\n`)

  expect(fixable).toBe(1)
  expect(text).toContain(`import { persisted, queryParam } from 'kay'`)
  expect(text).toContain(`persisted.query('a', '', { equals: false })`)
})

it('moves both navigation hooks of a file with one fix', async () => {
  const { text } = await fixed(navigationHooks, `import { onNavigate, onBeforeNavigate, signal } from 'kay'\nonBeforeNavigate(() => true)\nonNavigate(() => 1)\n`)

  expect(text).toBe(`import { signal, navigation } from 'kay'\nnavigation.onBeforeNavigate(() => true)\nnavigation.onNavigate(() => 1)\n`)
})

it('moves one name out of an import that keeps others, before, between or after them', async () => {
  const mixed = await fixed(movedImports, `import { defineEnv, s, sqliteCache } from 'kay/server'\n`)

  expect(mixed.text).toBe(`import { defineEnv } from 'kay/server'\nimport { s } from 'kay'\nimport { sqliteCache } from 'kay/cache'\n`)

  const before = await fixed(movedImports, `import { s, defineEnv, type RateLimit } from 'kay/server'\n`)

  expect(before.text).toBe(`import { defineEnv } from 'kay/server'\nimport { s, type RateLimit } from 'kay'\n`)

  const typed = await fixed(movedImports, `import type { RateLimit, Foo } from 'kay/server'\n`)

  expect(typed.text).toBe(`import type { Foo } from 'kay/server'\nimport type { RateLimit } from 'kay'\n`)
})

it('wraps only window, document and members of them as a listen target', async () => {
  const globals = await fixed(listenTarget, `import { listen } from 'kay'\nlisten(document.body, 'click', () => 1)\n`)

  expect(globals.text).toContain(`listen(() => document.body, 'click'`)

  const signal = await fixed(listenTarget, `import { listen, signal } from 'kay'\nconst panel = signal<HTMLElement>()\nlisten(panel, 'scroll', () => 1)\n`)

  expect(signal.found).toBe(0)
})

it('rewrites an island listening to the swap\'s events when the handler takes no parameter, and leaves listen imported while another call needs it', async () => {
  const { text, fixable, found } = await fixed(islandEvents, `import { listen } from 'kay'\nlisten(() => document, 'kay:navigate', () => 1)\nlisten(() => document, 'kay:navigate-start', function () {\n  return 2\n})\n`)

  expect(found).toBe(2)
  expect(fixable).toBe(2)
  expect(text).toBe(`import { navigation } from 'kay'\nnavigation.onNavigate(() => 1)\nnavigation.onStart(function () {\n  return 2\n})\n`)

  const kept = await fixed(islandEvents, `import { listen } from 'kay'\nlisten(() => document, 'kay:navigate-error', () => 1)\nlisten(() => window, 'resize', () => 2)\n`)

  expect(kept.text).toBe(`import { listen, navigation } from 'kay'\nnavigation.onError(() => 1)\nlisten(() => window, 'resize', () => 2)\n`)
})

it('reports an island listening to a form or a handler reading the event with the hook to write, and no fix', async () => {
  const { text, found, fixable } = await fixed(islandEvents, `import { listen } from 'kay'\nlisten(() => document, 'kay:navigate', event => event.detail.url)\nlisten(() => form, 'kay:action-start', () => 1)\nlisten(() => document, 'kay:consent', () => 2)\n`)

  expect(found).toBe(3)
  expect(fixable).toBe(0)
  expect(text).toContain(`'kay:action-start'`)
})

it('leaves a plain script listening to the events of kay, and an unrelated event of an island', async () => {
  const plain = await fixed(islandEvents, `document.addEventListener('kay:navigate', () => 1)\n`)
  const other = await fixed(islandEvents, `import { listen } from 'kay'\nlisten(() => document, 'kay:renew', () => 1)\nlisten(() => document, 'click', () => 2)\n`)

  expect(plain.found + other.found).toBe(0)
})

it('leaves an island that has a navigation of its own to the app', async () => {
  const { found, fixable } = await fixed(islandEvents, `import { listen } from 'kay'\nconst navigation = 1\nlisten(() => document, 'kay:navigate', () => navigation)\n`)

  expect(found).toBe(1)
  expect(fixable).toBe(0)
})

it('keeps listen imported when a template or another call still reads it, and leaves a nested rewritable call without a fix', async () => {
  const root = await scratchDir('one-state-api-')
  const file = join(root, 'src/part.kay')

  await Bun.write(file, `---\nimport { listen } from 'kay'\n\nlisten(() => document, 'kay:navigate', () => 1)\n---\nbutton(onClick={() => listen(() => window, 'resize', () => 2)}) x\n`)

  const found = await islandEvents(root, {})

  await applySafeFixes(root, found)
  expect(await Bun.file(file).text()).toContain(`import { listen, navigation } from 'kay'`)

  const nested = await fixed(islandEvents, `import { listen } from 'kay'\nlisten(() => document, 'kay:navigate', () => {\n  listen(() => document, 'kay:navigate-start', () => 1)\n})\n`)

  expect(nested.found).toBe(2)
  expect(nested.fixable).toBe(0)
})
