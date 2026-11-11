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

      const { promise: sent, resolve: send } = Promise.withResolvers<void>()
      const { promise: typed, resolve: answer } = Promise.withResolvers<void>()

      // The answer to `el` is held once the server gave it until `ys` is typed, which is the key landing while the navigate is in flight, its own navigate still to come.
      await page.route(url => url.pathname === '/slow' && url.searchParams.get('q') === 'el', async (request) => {
        const held = await request.fetch()

        send()
        await typed
        await request.fulfill({ ...held, body: held.text() })
      })
      await page.click('.field')
      await page.type('el')
      await sent

      expect(await page.text('p.searched')).toBe('')

      await page.type('ys')
      answer()
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

  // Keys typed after the swap and before the island hydrated land in the server's markup, which hydration writes its value over: they are kept and reach the island as an input event.
  const afterSwap = {
    'production': {},
    'dev': { dev: true },
    'a trailing slash': { trailingSlash: 'always' as const },
  }

  for (const [kind, options] of Object.entries(afterSwap)) {
    it(`keeps keys typed before a swapped-in field hydrates (${kind}) and tells the island`, async () => {
      const site = await testSite({ root: 'tests/fixtures/caret-field', ...options, browser: { path } })

      try {
        const page = await site.open('trailingSlash' in options ? '/bound/' : '/bound')

        // The keys arrive right as the swap hands the body to hydration, before the island's chunk resolves.
        await page.evaluate(() => {
          document.addEventListener('kay:navigate', () => {
            const field = document.activeElement as HTMLInputElement

            field.value += 'sia'
            field.setSelectionRange(field.value.length, field.value.length)
            field.dispatchEvent(new InputEvent('input', { bubbles: true }))
          }, { once: true })
        })
        await page.click('.field')
        await page.type('ely')
        await page.waitUntil(() => document.querySelector('p.searched')!.textContent === 'elysia')

        expect(await page.evaluate(() => {
          const f = document.querySelector<HTMLInputElement>('.field')!

          return [document.activeElement === f, f.value, f.selectionStart]
        })).toEqual([true, 'elysia', 6])
        expect(page.errors).toEqual([])
      }
      finally {
        await site.close()
      }
    }, 60_000)
  }

  it('keeps keys typed at once after a swap on a throttled CPU', async () => {
    const site = await testSite({ root: 'tests/fixtures/caret-field', browser: { path } })

    try {
      const page = await site.open('/bound')

      await page.cdp('Emulation.setCPUThrottlingRate', { rate: 20 })
      await page.click('.field')
      await page.type('ely')
      await page.waitUntil(() => document.querySelector('p.searched')!.textContent === 'ely')
      await page.type('sia')
      await page.waitUntil(() => document.querySelector('p.searched')!.textContent === 'elysia')

      expect(await page.evaluate(() => document.querySelector<HTMLInputElement>('.field')!.value)).toBe('elysia')
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
  // Keys typed in the swap's own turn, which hydration of a field in a `visible` or `idle` island writes its value over later.
  const typeAtNavigate = async (page: TestPage, keys: string) => page.evaluate((added: string) => {
    document.addEventListener('kay:navigate', () => {
      const field = document.activeElement as HTMLInputElement

      field.value += added
      field.dispatchEvent(new InputEvent('input', { bubbles: true }))
    }, { once: true })
  }, keys)

  const lazy = { 'a visible island': '/lazy', 'an idle island': '/lazy?when=idle' }

  for (const [kind, route] of Object.entries(lazy)) {
    it(`keeps keys typed before ${kind} hydrates, and tells the island`, async () => {
      const site = await testSite({ root: 'tests/fixtures/caret-field', browser: { path } })

      try {
        const page = await site.open(route)

        await typeAtNavigate(page, 'sia')
        await page.click('.field')
        await page.type('ely')
        await page.waitUntil(() => document.querySelector('p.searched')!.textContent === 'elysia')

        expect(await page.evaluate(() => [document.activeElement === document.querySelector('.field'), document.querySelector<HTMLInputElement>('.field')!.value])).toEqual([true, 'elysia'])
        expect(page.errors).toEqual([])
      }
      finally {
        await site.close()
      }
    }, 60_000)
  }

  for (const kind of ['number', 'email'] as const) {
    it(`keeps keys typed into a ${kind} field before it hydrates`, async () => {
      const site = await testSite({ root: 'tests/fixtures/caret-field', browser: { path } })

      try {
        const page = await site.open(`/${kind}`)
        const [first, more, whole] = kind === 'number' ? ['12', '34', '1234'] : ['a@b', '.fr', 'a@b.fr']

        await typeAtNavigate(page, more)
        await page.click('.field')
        await page.type(first)
        await page.waitUntil((all: string) => document.querySelector('p.searched')!.textContent === all, undefined, whole)

        expect(await page.evaluate(() => document.querySelector<HTMLInputElement>('.field')!.value)).toBe(whole)
        expect(page.errors).toEqual([])
      }
      finally {
        await site.close()
      }
    }, 60_000)
  }

  // The field far below stays unhydrated until scrolled to, so the first swap's watch is still waiting when the second arrives: it must not put its keys into the newer page's field.
  it('restores nothing from a swap a newer one superseded', async () => {
    const site = await testSite({ root: 'tests/fixtures/caret-field', browser: { path } })

    try {
      const page = await site.open('/far')

      await page.evaluate(() => {
        // The capture listeners on `input` the swaps leave registered.
        const live = { count: 0 }
        const add = document.addEventListener.bind(document)
        const remove = document.removeEventListener.bind(document)

        ;(window as unknown as { live: typeof live }).live = live
        document.addEventListener = ((type: string, ...rest: [EventListenerOrEventListenerObject, (boolean | AddEventListenerOptions)?]) => {
          if (type === 'input' && rest[1] === true)
            live.count++

          add(type, ...rest)
        }) as typeof document.addEventListener
        document.removeEventListener = ((type: string, ...rest: [EventListenerOrEventListenerObject, (boolean | EventListenerOptions)?]) => {
          if (type === 'input' && rest[1] === true)
            live.count--

          remove(type, ...rest)
        }) as typeof document.removeEventListener
        document.querySelector<HTMLInputElement>('.field')!.focus({ preventScroll: true })
        document.addEventListener('kay:navigate', () => {
          const field = document.activeElement as HTMLInputElement

          if (field.value === 'one') {
            field.value += 'KEYS'
            field.dispatchEvent(new InputEvent('input', { bubbles: true }))
          }
        })
        document.querySelector<HTMLButtonElement>('button.one')!.click()
      })
      await page.waitUntil(() => document.querySelector<HTMLInputElement>('.field')!.defaultValue === 'one')
      await page.evaluate(() => document.querySelector<HTMLButtonElement>('button.two')!.click())
      await page.waitUntil(() => document.querySelector<HTMLInputElement>('.field')!.defaultValue === 'two')
      await page.evaluate(() => document.querySelector('.field')!.scrollIntoView())
      await page.waitUntil(() => (document.querySelector('slot[data-component]:has(.field)') as unknown as { _$k?: boolean })._$k === true)

      expect(await page.evaluate(() => document.querySelector<HTMLInputElement>('.field')!.value)).toBe('two')
      // The first swap's watch ended when the second began, and the second's once its island hydrated.
      expect(await page.evaluate(() => (window as unknown as { live: { count: number } }).live.count)).toBe(0)
      expect(page.errors).toEqual([])
    }
    finally {
      await site.close()
    }
  }, 60_000)
})
