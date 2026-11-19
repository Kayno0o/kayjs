import type { TestPage } from '../src/test'
import process from 'node:process'
import { describe, expect, it } from 'bun:test'
import { browserPath, testSite } from '../src/test'

const path = browserPath()

// CI installs Chromium for these: there, a missing browser fails rather than skipping.
describe.skipIf(path === undefined && (process.env.CI ?? '') === '')('a refresh dropping the row it was posted from', () => {
  async function post(page: TestPage, row: number) {
    await page.evaluate((id) => {
      const select = document.querySelector<HTMLSelectElement>(`#row-${id} select`)!

      select.focus({ preventScroll: true })
      select.value = 'a'
      select.form!.requestSubmit()
    }, row)
    await page.waitUntil(id => document.querySelector(`#row-${id}`) === null, { timeout: '5s' }, row)
    await Bun.sleep(200)
  }

  it('keeps the scroll where it was', async () => {
    const site = await testSite({ root: 'tests/fixtures/scroll-anchor', browser: { path } })

    try {
      const page = await site.open('/')

      await page.evaluate(() => scrollTo(0, document.querySelector<HTMLElement>('#row-24')!.offsetTop + 20))

      const before = await page.evaluate(() => scrollY)

      await post(page, 24)

      expect(await page.evaluate(() => scrollY)).toBe(before)
      expect(page.errors).toEqual([])
    }
    finally {
      await site.close()
    }
  }, 60_000)

  it('gives the focus to the nearest row field of that name, never the first of the page', async () => {
    const site = await testSite({ root: 'tests/fixtures/scroll-anchor', browser: { path } })

    try {
      const page = await site.open('/')

      await page.evaluate(() => scrollTo(0, 1324))
      await post(page, 26)

      expect(await page.evaluate(() => document.activeElement?.closest('form')?.getAttribute('id'))).toBe('row-27')
    }
    finally {
      await site.close()
    }
  }, 60_000)

  // Holds the page a refresh fetches (not the action's own post) until `release()`, so what is typed meanwhile lands after the swap read the field.
  async function hold(page: TestPage) {
    await page.evaluate(() => {
      const w = window as unknown as { fetched: boolean, release: () => void }
      const { promise, resolve } = Promise.withResolvers<void>()
      const real = window.fetch.bind(window)

      w.fetched = false
      w.release = resolve
      window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const response = await real(input, init)

        if ((init?.method ?? 'GET').toUpperCase() === 'GET' && !w.fetched) {
          w.fetched = true
          await promise
        }

        return response
      }) as typeof fetch
    })
  }

  // A row is its form, by `kind`: with an id of its own, or told only by its hidden field in a list that stays.
  async function refreshWhileTyping(page: TestPage, typedRow: number, droppedRow: number, text: string, kind: 'id' | 'plain' = 'id') {
    await hold(page)
    await page.evaluate((id, dropped, plain) => {
      const row = (at: number) => plain ? `[data-row="${at}"]` : `#row-${at}`

      document.querySelector<HTMLInputElement>(`${row(id)} input[name=note]`)!.focus({ preventScroll: true })
      document.querySelector<HTMLFormElement>(row(dropped))!.requestSubmit()
    }, typedRow, droppedRow, kind === 'plain')
    await page.waitUntil(() => (window as unknown as { fetched: boolean }).fetched, { timeout: '5s' })
    await page.type(text)
    await page.evaluate(() => (window as unknown as { release: () => void }).release())
    await page.waitUntil((id, plain) => document.querySelector(plain ? `[data-row="${id}"]` : `#row-${id}`) === null, { timeout: '5s' }, droppedRow, kind === 'plain')
    await Bun.sleep(200)
  }

  const notes = async (page: TestPage) => page.evaluate(() => [...document.querySelectorAll<HTMLInputElement>('input[name=note]')].filter(field => field.value !== '').map(field => field.closest('form')!.getAttribute('id') ?? field.closest('form')!.getAttribute('data-row')))

  it('carries the text typed into the row it drops nowhere', async () => {
    const site = await testSite({ root: 'tests/fixtures/scroll-anchor', browser: { path } })

    try {
      const page = await site.open('/')

      await page.evaluate(() => scrollTo(0, 1800))
      await refreshWhileTyping(page, 33, 33, 'lost')

      expect(await notes(page)).toEqual([])
      expect(page.errors).toEqual([])
    }
    finally {
      await site.close()
    }
  }, 60_000)

  it('carries the text typed into a dropped row with no id, in a list that stays, nowhere', async () => {
    const site = await testSite({ root: 'tests/fixtures/scroll-anchor', browser: { path } })

    try {
      const page = await site.open('/plain')

      await refreshWhileTyping(page, 20, 20, 'lost', 'plain')

      expect(await notes(page)).toEqual([])
      expect(page.errors).toEqual([])
    }
    finally {
      await site.close()
    }
  }, 60_000)

  it('keeps the text typed into a row the refresh renders afresh', async () => {
    const site = await testSite({ root: 'tests/fixtures/scroll-anchor', browser: { path } })

    try {
      const page = await site.open('/')

      await refreshWhileTyping(page, 10, 35, 'kept')

      expect(await notes(page)).toEqual(['row-10'])
      expect(await page.evaluate(() => document.activeElement?.closest('form')?.getAttribute('id'))).toBe('row-10')
      expect(page.errors).toEqual([])
    }
    finally {
      await site.close()
    }
  }, 60_000)

  it('puts typed text back into the island field at its place on hydration, never the first of its name', async () => {
    const site = await testSite({ root: 'tests/fixtures/scroll-anchor', browser: { path } })

    try {
      const page = await site.open('/islands')

      const { promise: sent, resolve: send } = Promise.withResolvers<void>()
      const { promise: typed, resolve: answer } = Promise.withResolvers<void>()

      await page.route(url => url.pathname === '/islands' && url.searchParams.get('q') === '3:ab', async (request) => {
        const held = await request.fetch()

        send()
        await typed
        await request.fulfill({ ...held, body: held.text() })
      })
      await page.click('[data-row="3"]')
      await page.type('ab')
      await sent
      await page.type('c')
      // The island renders its field anew as it hydrates, writing the server's text: the field the swap focused leaves the page, and its text is put back.
      await page.evaluate(() => document.addEventListener('$h', (event) => {
        const field = (event.target as Element).querySelector<HTMLInputElement>('input')!
        const copy = field.cloneNode() as HTMLInputElement

        copy.value = field.getAttribute('value') ?? ''
        field.replaceWith(copy)
      }, { capture: true }))
      answer()
      await page.waitUntil(() => document.querySelector<HTMLInputElement>('[data-row="3"]')!.value === 'abc')
      await Bun.sleep(300)

      expect(await page.evaluate(() => [...document.querySelectorAll<HTMLInputElement>('input.field')].map(field => field.value))).toEqual(['', '', 'abc', ''])
      expect(page.errors).toEqual([])
    }
    finally {
      await site.close()
    }
  }, 60_000)
})
