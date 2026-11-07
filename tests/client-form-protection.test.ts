import type { Action } from '../src/runtime'
import { join } from 'node:path'
import process from 'node:process'
import { describe, expect, it, setSystemTime } from 'bun:test'
import { STAMP_FIELD } from '../src/runtime/action'
import { signStamp, stampTime } from '../src/server/stamp'
import { browserPath, testSite } from '../src/test'

const ROOT = 'tests/fixtures/client-forms'
// Created first: it is the site that makes the fixture's modules importable.
const site = await testSite({ root: ROOT, security: false, browser: true })
const { guarded, trapped, open, limited, plainOnly, quiet } = await import(join(import.meta.dir, 'fixtures/client-forms/src/routes/index.kay')) as {
  guarded: Action<{ note: string, website?: string }, number, 'website'>
  trapped: Action<{ website?: string }, number, 'website'>
  open: Action<Record<string, never>, number>
  limited: Action<Record<string, never>, number>
  plainOnly: Action<Record<string, never>, number>
  quiet: Action<Record<string, never>, number>
}
const path = browserPath()
const HONEYPOT = '<input name="website" type="text" tabindex="-1"'

// What a browser reads from the action's own URL, as kay's script does for a form an island built.
async function fields(site: { fetch: (path: string) => Promise<Response> }, url: string): Promise<{ html: string, response: Response }> {
  const response = await site.fetch(url.replace('/_kay/action/', '/_kay/fields/'))

  return { html: ((await response.json()) as { html: string }).html, response }
}

function stampIn(html: string): string | undefined {
  return new RegExp(`name="${STAMP_FIELD}" value="([^"]*)"`).exec(html)?.[1]
}

describe('the protection a form built in the browser asks its action for', () => {
  it('answers the honeypot and a stamp signed for that action, never cached', async () => {
    const { html, response } = await fields(site, guarded.url)
    const stamp = stampIn(html)

    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(html).toContain(HONEYPOT)
    expect(stamp).toBeDefined()
    expect(stampTime(guarded.url, stamp)).toBeGreaterThan(Date.now() - 5000)
    expect(stampTime(trapped.url, stamp)).toBeUndefined()
  })

  it('answers the honeypot alone for an action with no minTime, and nothing for one with neither', async () => {
    expect((await fields(site, trapped.url)).html).toBe(`<div style="position:absolute;left:-9999px;width:1px;height:1px;overflow:hidden" aria-hidden="true" inert>${HONEYPOT} autocomplete="off" data-1p-ignore data-lpignore="true" data-bwignore></div>`)
    expect((await fields(site, open.url)).html).toBe('')
  })

  it('answers nothing for an action with a rateLimit alone', async () => {
    expect((await fields(site, limited.url)).html).toBe('')
  })

  it('leaves plain and pretend as they were: a plain post with no stamp is refused, a call is not, and a post sent too soon is answered as if it went through', async () => {
    expect((await fields(site, plainOnly.url)).html).toContain(STAMP_FIELD)
    expect((await site.submit(plainOnly, {}, { from: '/', stamp: '' })).html).toContain('This form has expired')
    expect(await site.call(plainOnly, {})).toBe(1)
    expect((await site.submit(quiet, {}, { from: '/', openedFor: 0 })).html).not.toContain('Sent too fast')
  })

  it('answers 404 for an address that is no action\'s', async () => {
    expect((await site.fetch('/_kay/fields/src/routes/index.kay/nothing')).status).toBe(404)
  })

  it('has its stamp accepted once minTime passed, and refuses it sooner, as the server rendered form\'s is', async () => {
    const start = Date.now()

    try {
      setSystemTime(start)

      const stamp = stampIn((await fields(site, guarded.url)).html)!

      expect((await site.submit(guarded, { note: 'hi' }, { from: '/', stamp })).html).toContain('Sent too fast')

      setSystemTime(start + 3000)
      expect((await site.submit(guarded, { note: 'hi' }, { from: '/', stamp })).html).toContain('Sent 2')
    }
    finally {
      setSystemTime()
    }
  })

  it('refuses a post with no stamp, a forged one or one of another action, like the server rendered form\'s', async () => {
    for (const stamp of ['', 'forged', signStamp(trapped.url, Date.now() - 60_000)])
      expect((await site.submit(guarded, { note: 'hi' }, { from: '/', stamp })).html).toContain('This form has expired')
  })

  it('refuses the honeypot filled in', async () => {
    expect((await site.submit(trapped, { website: 'spam' }, { from: '/' })).html).toContain('Leave this field empty')
  })

  it('writes the same fields in the server rendered form, once', async () => {
    const { html } = await site.visit('/')
    const { html: answered } = await fields(site, guarded.url)

    expect(html.match(/name="kay_since"/g)).toHaveLength(1)
    expect(html).toContain(answered.slice(0, answered.indexOf('<input type="hidden"')))
  })

  it.each([
    ['', undefined],
    ['/shop', 'never'],
    ['/shop', 'always'],
  ] as const)('answers at the action address under base "%s" with trailingSlash %s', async (base, trailingSlash) => {
    const site = await testSite({ root: ROOT, security: false, browser: true, ...base !== '' && { base }, ...trailingSlash && { trailingSlash } })
    const page = await site.visit('/')
    const url = (/<form class="server" action="([^"]*)"/).exec(page.html)![1]!
    const { html } = await fields(site, url)

    expect(url.startsWith(`${base}/_kay/action/`)).toBe(true)
    expect(html).toContain(HONEYPOT)
    expect(stampTime(guarded.url, stampIn(html))).toBeDefined()
  })
})

describe.skipIf(path === undefined && (process.env.CI ?? '') === '')('a form an island builds in Chromium', () => {
  it('gets its honeypot and a stamp when it takes focus, and its post goes through once minTime passed', async () => {
    await using page = await site.open('/', { path })

    await page.click('button.show')
    await page.waitFor('form.built')
    expect(await page.evaluate(() => document.querySelectorAll('form.built input[name="kay_since"]').length)).toBe(0)

    await page.evaluate(() => (document.querySelector('form.built input') as HTMLElement).focus())
    await page.waitFor('form.built input[name="kay_since"]')
    expect(await page.evaluate(() => document.querySelectorAll('form.built input[name="website"]').length)).toBe(1)

    await page.fill('form.built input', 'hello')
    await page.evaluate(async () => new Promise(resolve => setTimeout(resolve, 2200)))
    await page.click('form.built button')
    await page.waitFor('p.sent', { text: 'Sent 5' })
    expect(page.errors).toEqual([])
  })

  it('has a submit with no focus wait for the fields, and be refused as too fast', async () => {
    await using page = await site.open('/', { path })

    await page.click('button.show')
    await page.waitFor('form.built')
    await page.evaluate(() => (document.querySelector('form.built') as HTMLFormElement).requestSubmit())
    await page.waitFor('p.error', { text: 'Sent too fast' })
  })

  it('adds nothing to a form of an action with no protection, nor to one the server rendered', async () => {
    await using page = await site.open('/', { path })

    await page.click('button.show')
    await page.waitFor('form.open')
    await page.evaluate(() => (document.querySelector('form.server input') as HTMLElement).focus())
    await page.evaluate(() => (document.querySelector('form.open button') as HTMLElement).focus())
    await page.evaluate(async () => new Promise(resolve => setTimeout(resolve, 300)))
    expect(await page.evaluate(() => document.querySelectorAll('form.open input, form.open div').length)).toBe(0)
    expect(await page.evaluate(() => document.querySelectorAll('form.server input[name="kay_since"]').length)).toBe(1)
  })

  type Page = Awaited<ReturnType<typeof site.open>>

  // The requests the page made for form fields.
  async function fieldRequests(page: Page): Promise<string[]> {
    return page.evaluate(() => performance.getEntriesByType('resource').map(entry => new URL(entry.name).pathname).filter(name => name.includes('/_kay/fields/')))
  }

  async function focusOn(page: Page, selector: string): Promise<void> {
    await page.evaluate((query: string) => {
      const control = document.querySelector(query) as HTMLElement

      control.blur()
      control.focus()
    }, selector)
  }

  it('asks once for a form of an action with no check, and for none the server rendered with its fields, in an island or outside one', async () => {
    await using page = await site.open('/', { path })

    await page.click('button.show')
    await page.waitFor('form.open')
    await focusOn(page, 'form.hydrated button')
    await focusOn(page, 'form.server input')
    await page.evaluate(async () => new Promise(resolve => setTimeout(resolve, 300)))
    expect(await fieldRequests(page)).toEqual([])

    await focusOn(page, 'form.open button')
    await focusOn(page, 'form.limited button')
    await focusOn(page, 'form.open button')
    await page.evaluate(async () => new Promise(resolve => setTimeout(resolve, 300)))
    expect(await fieldRequests(page)).toHaveLength(2)
  })

  it('asks again after a failed request, and when the island drew the form again without the fields', async () => {
    await using page = await site.open('/', { path })

    await page.click('button.show')
    await page.waitFor('form.built')
    await page.evaluate(() => {
      Object.assign(window, { realFetch: window.fetch.bind(window), fetch: async () => Promise.reject(new Error('offline')) })
    })
    await focusOn(page, 'form.built input')
    await page.evaluate(async () => new Promise(resolve => setTimeout(resolve, 200)))
    expect(await page.evaluate(() => document.querySelectorAll('form.built input[name="kay_since"]').length)).toBe(0)

    await page.evaluate(() => {
      Object.assign(window, { fetch: (window as unknown as { realFetch: typeof fetch }).realFetch })
    })
    await focusOn(page, 'form.built input')
    await page.waitFor('form.built input[name="kay_since"]')

    await page.evaluate(() => {
      for (const node of document.querySelectorAll('form.built input[name="kay_since"], form.built div[inert]'))
        node.remove()
    })
    await focusOn(page, 'form.built input')
    await page.waitFor('form.built input[name="kay_since"]')
    expect(await page.evaluate(() => document.querySelectorAll('form.built input[name="kay_since"]').length)).toBe(1)
    expect(await page.evaluate(() => document.querySelectorAll('form.built input[name="website"]').length)).toBe(1)
  })

  it('gives each of two forms of one action its own fields', async () => {
    await using page = await site.open('/', { path })

    await page.click('button.show')
    await page.waitFor('form.twin')
    await focusOn(page, 'form.built input')
    await focusOn(page, 'form.twin input')
    await page.waitFor('form.twin input[name="kay_since"]')
    await page.waitFor('form.built input[name="kay_since"]')
    expect(await page.evaluate(() => document.querySelectorAll('form.twin input[name="kay_since"]').length)).toBe(1)
    expect(await page.evaluate(() => document.querySelectorAll('form.built input[name="kay_since"]').length)).toBe(1)
  })

  it('drops a slow answer for the form\'s action once a submitter asked for another', async () => {
    await using page = await site.open('/', { path })

    await page.click('button.show')
    await page.waitFor('form.multi')
    await page.evaluate((slow: string) => {
      const real = window.fetch.bind(window)
      const sent: string[][] = []

      Object.assign(window, {
        sent,
        fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
          if (String(input).endsWith(slow))
            await new Promise(resolve => setTimeout(resolve, 1200))

          return real(input, init)
        },
      })
      // The post never goes out, so the form stays to be read.
      XMLHttpRequest.prototype.send = function (body) {
        sent.push(body instanceof FormData || body instanceof URLSearchParams ? [...body.keys()] : [])
      }
      const form = document.querySelector('form.multi') as HTMLFormElement

      form.querySelector('input')!.focus()
      form.requestSubmit(form.querySelector('button.alt'))
    }, guarded.url.replace('/_kay/action/', '/_kay/fields/'))
    await page.evaluate(async () => new Promise(resolve => setTimeout(resolve, 1800)))
    expect(await page.evaluate(() => document.querySelectorAll('form.multi input[name="kay_since"]').length)).toBe(0)
    expect(await page.evaluate(() => document.querySelectorAll('form.multi input[name="website"]').length)).toBe(1)
    expect(await page.evaluate(() => (window as unknown as { sent: string[][] }).sent.flat().includes('kay_since'))).toBe(false)
  })

  it('asks for the action a submitter names, not the form\'s', async () => {
    await using page = await site.open('/', { path })

    await page.click('button.show')
    await page.waitFor('form.multi')
    await focusOn(page, 'form.multi input')
    await page.waitFor('form.multi input[name="kay_since"]')
    await page.evaluate(() => {
      const form = document.querySelector('form.multi') as HTMLFormElement

      form.requestSubmit(form.querySelector('button.alt'))
    })
    await page.evaluate(async () => new Promise(resolve => setTimeout(resolve, 500)))
    expect((await fieldRequests(page)).some(name => name.endsWith('/trapped'))).toBe(true)
  })
})
