import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import process from 'node:process'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { browserPath, testSite } from '../src/test'
import { fixtureCopy } from './scratch'

const path = browserPath()
const CONFIG = 'import tailwind from \'bun-plugin-tailwind\'\nimport { defineConfig } from \'kay/server\'\n\nexport default defineConfig({ plugins: [tailwind] })\n'

describe.skipIf(path === undefined && (process.env.CI ?? '') === '')('the class table in a browser', () => {
  let root = ''
  let site: Awaited<ReturnType<typeof testSite>>

  beforeAll(async () => {
    root = await fixtureCopy('class-merge')
    await Bun.write(join(root, 'kay.config.ts'), CONFIG)
    site = await testSite({ root, browser: { path } })
  }, 120_000)

  afterAll(async () => {
    await site?.close()
    await rm(root, { recursive: true, force: true })
  })

  it('hydrates the classes the server resolved and resolves the ones an island changes, as the server would', async () => {
    const served = await site.visit('/')
    const page = await site.open('/')
    const classes = async (selector: string) => page.evaluate((query: string) => document.querySelector(query)?.className, selector)

    expect(served.html).toContain('class="p-2 bg-red-500"')
    expect(await classes('button.bg-red-500')).toBe('p-2 bg-red-500')
    expect(await classes('.literal')).toBe('literal p-6')
    expect(await classes('.panel .box')).toBe('box text-sm text-red-500 p-5')

    await page.click('button.bg-red-500')
    expect(await classes('button.bg-red-500')).toBe('bg-red-500 p-4')

    await page.click('button.open')
    await page.waitFor('p.opened')
    expect(await classes('p.opened')).toBe('opened mt-4')
    expect(page.errors).toEqual([])
  }, 60_000)
})
