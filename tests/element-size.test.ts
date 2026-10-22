import process from 'node:process'
import { afterAll, describe, expect, it } from 'bun:test'
import { browserPath, testSite } from '../src/test'

const site = await testSite({ root: 'tests/fixtures/element-size', browser: true })
const path = browserPath()

afterAll(async () => site.close())

describe('elementSize on the server', () => {
  it('reads 0 x 0 until the browser measures', async () => {
    const html = await (await site.fetch('/')).text()

    expect(html.replaceAll(/<!--.*?-->/g, '')).toContain('<p class="read">0 x 0</p>')
  })
})

describe.skipIf(path === undefined && (process.env.CI ?? '') === '')('elementSize in a browser', () => {
  const read = () => document.querySelector('p.read')!.textContent

  it('reads the content box, follows a resize and moves to an element rendered later', async () => {
    const page = await site.open('/', { path })

    await page.waitUntil(() => document.querySelector('p.read')!.textContent === '120 x 40')

    await page.click('button.widen')
    await page.waitUntil(() => document.querySelector('p.read')!.textContent === '300 x 40')

    await page.click('button.swap')
    await page.waitUntil(() => document.querySelector('p.read')!.textContent === '77 x 55')

    await page.click('button.widen')
    await page.click('button.swap')
    await page.waitUntil(() => document.querySelector('p.read')!.textContent === '120 x 40')

    expect(await page.evaluate(read)).toBe('120 x 40')
    expect(page.errors).toEqual([])
  }, 30_000)
})
