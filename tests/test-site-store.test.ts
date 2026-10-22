import type { Action } from '../src/runtime'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { expect, it } from 'bun:test'
import { appStore } from '../src/server/app-store'
import { testSite } from '../src/test'
import { fixtureCopy } from './scratch'

it('replaces a store the config names with memory, creating no file', async () => {
  const root = await fixtureCopy('rate-keys')
  const path = join(root, 'data', 'app.sqlite')

  await Bun.write(join(root, 'kay.config.ts'), `import { defineConfig, sqliteData } from 'kay/server'\n\nexport default defineConfig({ store: sqliteData(${JSON.stringify(path)}) })\n`)

  const site = await testSite({ root, islands: false, locals: request => ({ user: request.headers.get('x-user') ?? undefined }) })
  const actions = await import(resolve(root, 'src/routes/index.kay')) as Record<'perUser', Action<Record<never, never>, string>>

  try {
    expect(await site.call(actions.perUser, {}, { headers: { 'x-user': 'ada-memory' } })).toBe('ok')
    expect(existsSync(path)).toBe(false)
    expect(appStore()?.live).toBeUndefined()
  }
  finally {
    await site.close()
  }
})
