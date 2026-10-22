import type { TestPage } from '../src/test'
import process from 'node:process'
import { describe, expect, it } from 'bun:test'
import { browse, browserPath, testSite } from '../src/test'

const path = browserPath()

// CI installs Chromium for these: there, a missing browser fails rather than skipping.
describe.skipIf(path === undefined && (process.env.CI ?? '') === '')('a field an island re-hydrates on a query navigate', () => {
  // The field read back once the swap has replaced it: the one held before is gone, the focus is on the new one.
  const caret = async (page: TestPage) => page.evaluate(() => {
    const field = document.querySelector<HTMLInputElement | HTMLTextAreaElement>('.field')!
    const first = (window as unknown as { first: Element }).first

    return { replaced: !first.isConnected, focused: document.activeElement === field, value: field.value, start: field.selectionStart, end: field.selectionEnd, direction: field.selectionDirection }
  })

  // Typed, swapped, typed again at the end, then in the middle and over a selection: each time the caret and the selection are where they were left.
  async function typeAcross(page: TestPage) {
    await page.click('.field')
    await page.evaluate(() => void ((window as unknown as { first: Element }).first = document.querySelector('.field')!))
    await page.type('ely')
    await page.waitUntil(() => document.querySelector('p.searched')!.textContent === 'ely' && !(window as unknown as { first: Element }).first.isConnected)

    expect(await caret(page)).toMatchObject({ replaced: true, focused: true, value: 'ely', start: 3, end: 3 })

    await page.type('sia')
    await page.waitUntil(() => document.querySelector('p.searched')!.textContent === 'elysia')

    expect(await caret(page)).toMatchObject({ focused: true, value: 'elysia', start: 6, end: 6 })

    // In the middle of the text.
    await page.evaluate(() => {
      (window as unknown as { first: Element }).first = document.querySelector('.field')!
      document.querySelector<HTMLInputElement>('.field')!.setSelectionRange(2, 2)
    })
    await page.type('X')
    await page.waitUntil(() => document.querySelector('p.searched')!.textContent === 'elXysia' && !(window as unknown as { first: Element }).first.isConnected)

    expect(await caret(page)).toMatchObject({ focused: true, value: 'elXysia', start: 3, end: 3 })

    // A selection range and its direction, the swap triggered by an input event that changes nothing.
    await page.evaluate(() => {
      const field = document.querySelector<HTMLInputElement>('.field')!

      ;(window as unknown as { first: Element }).first = field
      field.setSelectionRange(1, 4, 'backward')
      field.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await page.waitUntil(() => !(window as unknown as { first: Element }).first.isConnected)

    expect(await caret(page)).toMatchObject({ focused: true, value: 'elXysia', start: 1, end: 4, direction: 'backward' })

    await page.type('Z')
    await page.waitUntil(() => document.querySelector('p.searched')!.textContent === 'eZsia')

    expect(await caret(page)).toMatchObject({ focused: true, value: 'eZsia', start: 2, end: 2 })
    expect(page.errors).toEqual([])
  }

  const kinds = { input: 'text input', area: 'textarea', nested: 'text input in an island under another island' }

  for (const [route, kind] of Object.entries(kinds)) {
    it(`keeps the caret of a ${kind}`, async () => {
      const site = await testSite({ root: 'tests/fixtures/caret-field', browser: { path } })

      try {
        await typeAcross(await site.open(`/${route}`))
      }
      finally {
        await site.close()
      }
    }, 60_000)
  }

  it('keeps the caret at the end of a text the server shortened, and a long text scrolled to the caret', async () => {
    const site = await testSite({ root: 'tests/fixtures/caret-field', browser: { path } })

    try {
      const page = await site.open('/trimmed')

      await page.click('.field')
      await page.type('ab ')
      await page.waitUntil(() => document.querySelector('p.searched')!.textContent === 'ab' && document.querySelector<HTMLInputElement>('.field')!.value === 'ab')

      expect(await page.evaluate(() => [document.activeElement === document.querySelector('.field'), document.querySelector<HTMLInputElement>('.field')!.selectionStart])).toEqual([true, 2])

      const long = 'x'.repeat(120)

      await page.fill('.field', '')
      await page.type(long)
      await page.waitUntil(() => document.querySelector('p.searched')!.textContent.length === 120 && document.querySelector<HTMLInputElement>('.field')!.value.length === 120)

      expect(await page.evaluate(() => {
        const f = document.querySelector<HTMLInputElement>('.field')!

        return [f.selectionStart, f.scrollLeft > 0]
      })).toEqual([120, true])
      expect(page.errors).toEqual([])
    }
    finally {
      await site.close()
    }
  }, 60_000)

  it('keeps what was typed while the navigate was in flight, and asks for it next', async () => {
    const site = await testSite({ root: 'tests/fixtures/caret-field', browser: { path } })

    try {
      const page = await site.open('/slow')

      await page.click('.field')
      await page.type('el')
      // The debounce sends `el` after 400ms and the server answers 600ms later: `ys` lands between the two, and its own navigate is still to come.
      await Bun.sleep(800)

      expect(await page.text('p.searched')).toBe('')

      await page.type('ys')
      await page.waitUntil(() => document.querySelector('p.searched')!.textContent === 'el')

      expect(await page.evaluate(() => {
        const f = document.querySelector<HTMLInputElement>('.field')!

        return [document.activeElement === f, f.value, f.selectionStart]
      })).toEqual([true, 'elys', 4])

      // The kept keys were searched for without another key.
      await page.waitUntil(() => document.querySelector('p.searched')!.textContent === 'elys')
      await page.type('ia')
      await page.waitUntil(() => document.querySelector('p.searched')!.textContent === 'elysia' && document.querySelector<HTMLInputElement>('.field')!.value === 'elysia')

      expect(await page.evaluate(() => document.querySelector<HTMLInputElement>('.field')!.selectionStart)).toBe(6)
      expect(page.errors).toEqual([])
    }
    finally {
      await site.close()
    }
  }, 60_000)

  it('keeps it under a trailing slash', async () => {
    const site = await testSite({ root: 'tests/fixtures/caret-field', trailingSlash: 'always', browser: { path } })

    try {
      await typeAcross(await site.open('/input/'))
    }
    finally {
      await site.close()
    }
  }, 60_000)

  it('keeps it under a base', async () => {
    const base = '/repo'
    const site = await testSite({ root: 'tests/fixtures/caret-field', trailingSlash: 'always', base, browser: { path } })
    const front = Bun.serve({
      port: 0,
      async fetch(request) {
        const url = new URL(request.url)

        return site.handle(new Request(new URL(`${url.pathname.slice(base.length) || '/'}${url.search}`, 'http://localhost'), { method: request.method, headers: request.headers, body: request.body, redirect: 'manual' }))
      },
    })
    const page = await browse(`${front.url.origin}${base}/input/`, { path })

    try {
      await typeAcross(page)
    }
    finally {
      await page.close()
      await front.stop(true)
      await site.close()
    }
  }, 60_000)
})
