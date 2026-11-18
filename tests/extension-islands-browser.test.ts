import { rm } from 'node:fs/promises'
import process from 'node:process'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { browserPath, testSite } from '../src/test'
import { fixtureCopy } from './scratch'

const path = browserPath()

// The fixture has no package.json, so kayjs-ui resolves through the workspace from `packages/ui`, a folder above the copy's root.
describe.skipIf(path === undefined && (process.env.CI ?? '') === '')('an extension\'s islands in a browser', () => {
  let root = ''
  let site: Awaited<ReturnType<typeof testSite>>

  beforeAll(async () => {
    root = await fixtureCopy('ui-list')
    site = await testSite({ root, browser: { path } })
  }, 120_000)

  afterAll(async () => {
    await site?.close()
    await rm(root, { recursive: true, force: true })
  })

  it('hydrate when the library resolves outside the project root', async () => {
    const served = await site.visit('/')
    const page = await site.open('/')

    const outside = served.html.match(/<slot data-component="\.\.\/[^>]*>/g) ?? []

    expect(outside.length).toBeGreaterThan(0)
    expect(outside.filter(tag => !tag.includes(' data-chunk="'))).toEqual([])
    expect(await page.evaluate(() => [...document.querySelectorAll('[data-component]')].every(island => (island as { _$k?: unknown })._$k !== undefined))).toBe(true)
    expect(page.errors).toEqual([])
  }, 90_000)
})
