import { cp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import process from 'node:process'
import { describe, expect, it } from 'bun:test'
import { browserPath, testSite } from '../src/test'
import { kayCheck } from './check-helper'
import { scratchDir } from './scratch'

const path = browserPath()

describe('store in an island', () => {
  it('renders the plain values on the server, and a page without it carries none of the store', async () => {
    const site = await testSite({ root: 'tests/fixtures/store' })
    const page = await site.visit('/')

    expect(page.text('p.coins')).toBe('0')
    expect(page.text('p.ore')).toBe('0')
    expect(page.html).toContain('data-component="src/components/game.kay"')
    expect((await site.visit('/plain')).html).not.toContain('<script src')
  }, 60_000)

  it('types a store as the object it wraps, so a wrong write is a type error', async () => {
    const root = await scratchDir('store-check-')

    try {
      await cp(join(import.meta.dir, 'fixtures/store'), root, { recursive: true })
      await Bun.write(join(root, 'tsconfig.json'), JSON.stringify({
        compilerOptions: { target: 'ESNext', jsx: 'preserve', jsxImportSource: 'kay', lib: ['ESNext', 'DOM'], rootDirs: ['.', '.kay/types'], module: 'Preserve', moduleResolution: 'bundler', strict: true, noEmit: true, skipLibCheck: true },
        include: ['src', '.kay/types'],
      }))

      expect((await kayCheck([root])).code).toBe(0)

      await Bun.write(join(root, 'src/components/wrong.kay'), '---\nconst game = store({ coins: 0 })\n---\nbutton(onClick={() => game.coins = \'x\'}) {snapshot(game).coins}\n')

      const wrong = await kayCheck([root])

      expect(wrong.code).not.toBe(0)
      expect(wrong.output).toContain('wrong.kay')
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 90_000)

  describe.skipIf(path === undefined && (process.env.CI ?? '') === '')('in the browser', () => {
    it('updates the properties a mutation changed, a child island reading the same store through its prop', async () => {
      const site = await testSite({ root: 'tests/fixtures/store', browser: { path } })

      try {
        const page = await site.open('/')

        await page.click('button.earn')
        await page.click('button.tick')
        await page.click('button.tick')
        await page.click('button.hire')

        expect([await page.text('p.coins'), await page.text('p.ticks'), await page.text('p.miners'), await page.text('p.ore')]).toEqual(['5', '2', '2', '4'])
        expect(page.errors).toEqual([])
      }
      finally {
        await site.close()
      }
    }, 60_000)
  })
})
