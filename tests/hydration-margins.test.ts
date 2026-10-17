import { readdir, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'bun:test'
import { buildClient } from '../src/build/client'
import { clientOptionsOf } from '../src/project'
import { fixtureCopy } from './scratch'

async function scripts(dir: string): Promise<string> {
  const names = (await readdir(dir, { recursive: true })).filter(name => name.endsWith('.js'))

  return (await Promise.all(names.map(async name => Bun.file(join(dir, name)).text()))).join('\n')
}

describe('hydration margins', () => {
  it('hands the config\'s margins to the browser build', () => {
    expect(clientOptionsOf({ hydration: { visible: '50px' } }, { dev: false, underKayDev: false }).hydration).toEqual({ visible: '50px' })
    expect(clientOptionsOf({}, { dev: false, underKayDev: false }).hydration).toBeUndefined()
  })

  it('keeps 200px and a screen ahead unless the config sets a margin, and writes the one it sets', async () => {
    const dir = resolve(await fixtureCopy('navigation'))

    try {
      const plain = await scripts((await buildClient(dir, { navigation: true })).dir)

      expect(plain).toContain('200px')
      expect(plain).toContain('100% 0px')

      const set = await scripts((await buildClient(dir, { navigation: true, hydration: { visible: '640px', serverIslands: '300% 0px' } })).dir)

      expect(set).toContain('640px')
      expect(set).toContain('300% 0px')
      expect(set).not.toContain('200px')
      expect(set).not.toContain('100% 0px')
    }
    finally {
      await rm(dir, { recursive: true, force: true })
    }
  }, 120_000)
})
