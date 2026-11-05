import { join } from 'node:path'
import { expect, it } from 'bun:test'
import { appStore } from '../src/server/app-store'
import { testSite } from '../src/test'
import { fixtureCopy } from './scratch'

it('keeps no app store for an app naming none, so libraries see what they see in production', async () => {
  const root = await fixtureCopy('rate-keys')

  await Bun.write(join(root, 'kay.config.ts'), `import { defineConfig } from 'kay/server'\n\nexport default defineConfig({})\n`)

  const site = await testSite({ root, islands: false })

  try {
    expect(appStore()).toBeUndefined()
  }
  finally {
    await site.close()
  }
})
