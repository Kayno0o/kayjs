import type { Action } from '../src/runtime'
import type { TestSite } from '../src/test'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { chromium } from 'playwright-core'
import { browserPath, testSite } from '../src/test'

const site = await testSite({ routes: 'tests/fixtures/forms/src/routes' })
const { save, ping } = await import(join(import.meta.dir, 'fixtures/forms/src/routes/index.kay')) as {
  save: Action<Record<string, string | boolean>, unknown, 'website'>
  ping: Action<Record<string, never>, string>
}
const path = browserPath() ?? (existsSync(chromium.executablePath()) ? chromium.executablePath() : undefined)
const REFUSED = { name: 'A', password: 'hunter2', bio: 'Hi <b>', plan: 'pro', size: 'l', news: 'on', website: '' }

describe('a form posting to an action', () => {
  it('renders its own values, and marks nothing invalid, before any post', async () => {
    const { html } = await site.visit('/')

    expect(html).toContain('<input name="name" value="Ada">')
    expect(html).toContain('<textarea name="bio">Default bio</textarea>')
    expect(html).toContain('<option value="free" selected>Free</option><option value="pro">Pro</option>')
    expect(html).toContain('<input type="radio" name="size" value="s" checked>')
    expect(html).toContain('<input type="checkbox" name="terms" checked>')
    expect(html).not.toContain('aria-invalid')
  })

  it('shows a refused post again with what was sent, refused fields marked, a password never echoed', async () => {
    const { status, html } = await site.submit(save, REFUSED, { from: '/' })

    expect(status).toBe(422)
    expect(html).toContain('<input name="name" value="A" aria-invalid="true">')
    expect(html).toContain('<input type="password" name="password">')
    expect(html).not.toContain('hunter2')
    expect(html).toContain('<textarea name="bio">Hi &lt;b></textarea>')
    expect(html).toContain('<option value="free">Free</option><option value="pro" selected>Pro</option>')
    expect(html).toContain('<input type="radio" name="size" value="s">')
    expect(html).toContain('<input type="radio" name="size" value="l" checked>')
    expect(html).toContain('<input type="checkbox" name="news" checked>')
    expect(html).toContain('<input type="checkbox" name="terms">')
    expect(html).toContain('<p class="error">Too short</p>')
    expect(html).toContain('<p class="status">422</p>')
  })

  it('leaves the honeypot empty when a bot filled it in', async () => {
    const { status, html } = await site.submit(save, { ...REFUSED, name: 'Ada', website: 'spam.example' }, { from: '/' })

    expect(status).toBe(422)
    expect(html).not.toContain('spam.example')
    expect(html).toContain('<input name="website" tabindex="-1" autocomplete="off" aria-hidden="true" aria-invalid="true">')
  })

  it('reads what the handler failed with, and what one that went through returned, off the action', async () => {
    const taken = await site.submit(save, { ...REFUSED, name: 'Ada' }, { from: '/' })
    const pinged = await site.submit(ping, {}, { from: '/' })

    expect(taken.status).toBe(409)
    expect(taken.html).toContain('<p class="taken">Taken</p>')
    expect(taken.html).toContain('<input name="name" value="Ada">')
    expect(pinged.html).toContain('<p class="done">Saved</p>')
    expect((await site.visit('/')).html).not.toContain('class="done"')
  })
})

describe.skipIf(!path && !process.env.CI)('an island form posting to an action', () => {
  let browser: TestSite

  beforeAll(async () => {
    browser = await testSite({ routes: 'tests/fixtures/forms/src/routes', browser: { path } })
  }, 60_000)

  afterAll(async () => browser?.close())

  it('hydrates the page a refused post renders as the server drew it, the field filled in and marked', async () => {
    const page = await browser.open('/')

    await page.fill('form.signup input', 'nope')
    await page.click('button.post')
    await page.waitFor('p.signup-error', { text: 'Not an email' })

    expect(await page.value('form.signup input')).toBe('nope')
    expect(await page.evaluate(() => document.querySelector('form.signup input')?.getAttribute('aria-invalid'))).toBe('true')
    expect(page.errors).toEqual([])
  })

  it('shows the page again once a call went through, unless the call says not to', async () => {
    const page = await browser.open('/')
    const before = Number(await page.text('p.tally'))

    await page.click('button.bump')
    await page.waitFor('p.tally', { text: String(before + 1) })
    await page.click('button.quiet')
    await page.evaluate(async () => new Promise(resolve => setTimeout(resolve, 300)))

    expect(await page.text('p.tally')).toBe(String(before + 1))

    await page.reload()

    expect(await page.text('p.tally')).toBe(String(before + 2))
    expect(page.errors).toEqual([])
  })

  it('shows what a call was refused for, reactively', async () => {
    const page = await browser.open('/')

    expect(await page.text('p.signup-error')).toBeNull()

    await page.click('button.call')
    await page.waitFor('p.signup-error', { text: 'Not an email' })

    expect(await page.evaluate(() => document.querySelector('form.signup input')?.getAttribute('aria-invalid'))).toBe('true')
    expect(page.errors).toEqual([])
  })
})
