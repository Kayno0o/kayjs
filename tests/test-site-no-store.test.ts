import { join } from 'node:path'
import { expect, it } from 'bun:test'
import { appStore } from '../src/server/app-store'
import { defaultFileStore, memoryFiles } from '../src/server/storage'
import { testSite } from '../src/test'
import { fixtureCopy } from './scratch'

// A process serves one project, so the tests of this file share one.
let shared: Promise<string> | undefined

async function storeLessRoot(): Promise<string> {
  shared ??= (async () => {
    const root = await fixtureCopy('rate-keys')

    await Bun.write(join(root, 'kay.config.ts'), `import { defineConfig } from 'kay/server'\n\nexport default defineConfig({})\n`)

    return root
  })()

  return shared
}

it('keeps no app store for an app naming none, so libraries see what they see in production', async () => {
  const site = await testSite({ root: await storeLessRoot(), islands: false })

  try {
    expect(appStore()).toBeUndefined()
  }
  finally {
    await site.close()
  }
})

it('gives each site files of its own, released as it closes, whichever closes first', async () => {
  const root = await storeLessRoot()
  const outside = defaultFileStore()
  const first = await testSite({ root, islands: false })
  const ofFirst = defaultFileStore()
  const second = await testSite({ root, islands: false })
  const ofSecond = defaultFileStore()

  expect(ofFirst).not.toBe(outside)
  expect(ofSecond).not.toBe(ofFirst)

  await first.close()
  expect(defaultFileStore()).toBe(ofSecond)

  await second.close()
  expect(defaultFileStore()).toBe(outside)
})

it('serves the files a test names, with no store configured', async () => {
  const mine = memoryFiles()
  const outside = defaultFileStore()
  const site = await testSite({ root: await storeLessRoot(), islands: false, store: { files: mine } })

  try {
    expect(appStore()?.files).toBe(mine)
    expect(defaultFileStore()).toBe(outside)
  }
  finally {
    await site.close()
  }
})
