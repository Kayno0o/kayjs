import process from 'node:process'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { browserPath, testSite } from '../src/test'

const path = browserPath()

describe.skipIf(path === undefined && (process.env.CI ?? '') === '')('bind: on a component in a browser', () => {
  let site: Awaited<ReturnType<typeof testSite>>

  beforeAll(async () => {
    site = await testSite({ root: 'tests/fixtures/bind-component', browser: { path } })
  }, 120_000)

  afterAll(async () => site?.close())

  it('renders the bound value on the server', async () => {
    const served = await site.visit('/')

    expect(served.html).toContain('<button class="name">off</button>')
    expect(served.html).toContain('<button class="props">off</button>')
    expect(served.html).toContain('<p class="rest">yes</p>')
    expect(served.html).not.toContain('KayBindable')
  }, 60_000)

  it('hydrates it, and a click writes the parent signal by name, through the props object and through ...rest', async () => {
    const page = await site.open('/')

    for (const [button, out] of [['button.name', 'p.named'], ['button.props', 'p.props']] as const) {
      expect(await page.text(button)).toBe('off')
      await page.click(button)
      expect(await page.text(button)).toBe('on')
      expect(await page.text(out)).toBe('yes')
    }

    expect(await page.text('.wrap button')).toBe('on')
    await page.click('.wrap button')
    expect(await page.text('.wrap button')).toBe('off')
    expect(await page.text('p.rest')).toBe('no')
    expect(page.errors).toEqual([])
  }, 60_000)
})
