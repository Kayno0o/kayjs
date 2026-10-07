import type { Action } from '../src/runtime'
import type { TestSite } from '../src/test'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'
import { afterAll, beforeAll, describe, expect, it, spyOn } from 'bun:test'
import { chromium } from 'playwright-core'
import { compileKay } from '../src/compiler'
import { browserPath, testSite } from '../src/test'

const site = await testSite({ routes: 'tests/fixtures/forms/src/routes' })
const { save, ping, busy, odd } = await import(join(import.meta.dir, 'fixtures/forms/src/routes/index.kay')) as {
  save: Action<Record<string, string | boolean>, unknown, 'website'>
  ping: Action<Record<string, never>, string>
  busy: Action<Record<string, string>, unknown>
  odd: Action<Record<string, never>, unknown>
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
    expect(html).toContain('<form class="busy" action="/_kay/action/tests/fixtures/forms/src/routes/index.kay/busy" method="post" enctype="multipart/form-data">')
  })

  it('shows a refused post again with what was sent, refused fields marked, a password never echoed', async () => {
    const { status, html } = await site.submit(save, REFUSED, { from: '/' })

    expect(status).toBe(422)
    expect(html).toContain('<input name="name" value="A" aria-invalid="true" aria-describedby="save-name-error">')
    expect(html).toContain('<input type="password" name="password">')
    expect(html).not.toContain('hunter2')
    expect(html).toContain('<textarea name="bio">Hi &lt;b></textarea>')
    expect(html).toContain('<option value="free">Free</option><option value="pro" selected>Pro</option>')
    expect(html).toContain('<input type="radio" name="size" value="s">')
    expect(html).toContain('<input type="radio" name="size" value="l" checked>')
    expect(html).toContain('<input type="checkbox" name="news" checked>')
    expect(html).toContain('<input type="checkbox" name="terms">')
    expect(html).toContain('<p id="save-name-error" class="error">Too short</p>')
    expect(html).toContain('<p class="status">422</p>')
  })

  it('describes a refused field by the message the template shows for it, keeping an id or a description of the template\'s own', async () => {
    const { status, html } = await site.submit(busy, { topic: 'ab', note: 'long' }, { from: '/' })

    expect(status).toBe(422)
    expect(html).toContain('<input name="topic" value="ab" aria-invalid="true" aria-describedby="topic-problem">')
    expect(html).toContain('<p id="topic-problem">Too short</p>')
    expect(html).toContain('<input name="note" value="long" aria-invalid="true" aria-describedby="note-help busy-note-error">')
    expect(html).toContain('<p id="busy-note-error" class="note-error">Too long</p>')
    expect(html).toContain('<form class="busy" action="/_kay/action/tests/fixtures/forms/src/routes/index.kay/busy" method="post" enctype="multipart/form-data">')
  })

  it('describes a form by its own message once the handler refused it', async () => {
    const { status, html } = await site.submit(busy, { topic: 'abc' }, { from: '/' })

    expect(status).toBe(503)
    expect(html).toContain('<form class="busy" action="/_kay/action/tests/fixtures/forms/src/routes/index.kay/busy" method="post" enctype="multipart/form-data" aria-describedby="busy-error">')
    expect(html).toContain('<p id="busy-error" class="busy-error">Try later</p>')
    expect(html).toContain('<input name="topic" value="abc">')
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

describe('the messages a refused form is described by', () => {
  const FORM = `form(action={add})
  input(name="title" aria-describedby="help")
  input(name="tag")
  input(name="slug" aria-describedby={hint})
  p {add.error('tag')}
  if add.error('title') as message
    p {message}
  if add.error('slug') as message
    p {message}
  for row of rows
    if add.error('tag') as message
      p.row {message}
  if add.error() as message
    p(id="own-form") {message}
  if other.error('x') as message
    p.other {message}
`

  it('names the element an if block shows first, or one holding the error, after a description of the field\'s own', () => {
    const { tsx } = compileKay(FORM, 'page.kay', { output: 'html' })

    expect(tsx).toContain('"<input name=\\"title\\"" + KayAttribute("value", KayFormValue((add), "title")) + KayAttribute("aria-invalid", KayFormInvalid((add), "title")) + KayAttribute("aria-describedby", KayFormInvalid((add), "title") ? "help add-title-error" : "help")')
    expect(tsx).toContain('KayAttribute("aria-describedby", KayFormInvalid((add), "tag") ? "add-tag-error" : undefined)')
    expect(tsx).toContain('<p id=\\"add-tag-error\\">')
    expect(tsx).toContain('<p id=\\"add-title-error\\">')
    expect(tsx).toContain('KayAttribute("aria-describedby", KayFormInvalid((add), "") ? "own-form" : undefined)')
  })

  it('leaves a bound description, a row of a for and another action\'s message alone', () => {
    const { tsx } = compileKay(FORM, 'page.kay', { output: 'html' })

    expect(tsx).not.toContain('KayFormInvalid((add), "slug") ?')
    expect(tsx).toContain('<p class=\\"row\\">')
    expect(tsx).toContain('<p class=\\"other\\">')
  })

  it('describes the fields and the form of an island alike', () => {
    const { tsx } = compileKay(FORM, 'page.kay', { output: 'dom' })

    expect(tsx).toContain('"aria-describedby", KayFormInvalid((add), "title") ? "help add-title-error" : "help"));')
    expect(tsx).toContain('"aria-describedby", KayFormInvalid((add), "tag") ? "add-tag-error" : undefined));')
    expect(tsx).toContain('"aria-describedby", KayFormInvalid((add), "") ? "own-form" : undefined));')
    expect(tsx).toContain('<p id=\\"add-tag-error\\">')
    expect(tsx).not.toContain('KayFormInvalid((add), "slug") ?')
  })
})

describe.skipIf(!path && !process.env.CI)('an island form posting to an action', () => {
  let browser: TestSite

  beforeAll(async () => {
    browser = await testSite({ routes: 'tests/fixtures/forms/src/routes', browser: { path } })
  }, 60_000)

  afterAll(async () => browser?.close())

  it('hands the islands how a refused post went without what it sent, a failure no island can read left out', async () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => undefined)

    try {
      const refused = await browser.submit(save, { ...REFUSED, name: 'Ada', website: 'spam.example' }, { from: '/' })
      const unsendable = await browser.submit(odd, {}, { from: '/' })

      expect(refused.html).toContain('data-kay-outcome')
      expect(refused.html).not.toContain('spam.example')
      expect(refused.html).not.toContain('hunter2')
      expect(unsendable.status).toBe(409)
      expect(unsendable.html).not.toContain('data-kay-outcome')
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('cannot reach the page\'s islands'))
    }
    finally {
      warn.mockRestore()
    }
  })

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

  it('lets a navigation the caller starts once a call went through win over the refresh', async () => {
    const page = await browser.open('/')

    await page.click('button.away')
    await page.waitFor('h1', { text: 'Other' })

    expect(await page.path()).toBe('/other')
    expect(page.errors).toEqual([])
  })

  it('leaves what a call was refused for on the page that made it', async () => {
    const page = await browser.open('/')

    await page.click('button.call')
    await page.waitFor('p.signup-error', { text: 'Not an email' })
    await page.click('a.other')
    await page.waitFor('h1', { text: 'Other' })
    await page.click('a.home')
    await page.waitFor('p.tally')

    expect(await page.text('p.signup-error')).toBeNull()
    expect(page.errors).toEqual([])
  })

  it('shows what a call was refused for, reactively', async () => {
    const page = await browser.open('/')

    expect(await page.text('p.signup-error')).toBeNull()

    await page.click('button.call')
    await page.waitFor('p.signup-error', { text: 'Not an email' })

    expect(await page.evaluate(() => document.querySelector('form.signup input')?.getAttribute('aria-invalid'))).toBe('true')
    expect(await page.evaluate(() => document.querySelector('form.signup input')?.getAttribute('aria-describedby'))).toBe('join-email-error')
    expect(await page.evaluate(() => document.querySelector('p.signup-error')?.id)).toBe('join-email-error')
    expect(page.errors).toEqual([])
  })
})
