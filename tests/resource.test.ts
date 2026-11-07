import type { Resource } from '../src/runtime/live'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, spyOn } from 'bun:test'
import { flush, root, signal } from '../src/runtime'
import { API_MOUNT, resource } from '../src/runtime/live'
import { hydrationEnded, hydrationStarted } from '../src/runtime/reactive'
import { testSite } from '../src/test'
import { scratchDir } from './scratch'

// A route standing in for a module's: the types are the real module's, which these tests do not need.
const read = resource as unknown as (module: unknown, path: string, options?: unknown) => Resource<any> // eslint-disable-line ts/no-explicit-any -- any value the fake route answers
const dir = await scratchDir('resource-')
const files: Record<string, string> = {
  'src/api/data.ts': `import { t } from 'elysia'
import { api } from 'kay/server'
import { renderLocale } from 'kay/server'

export const calls = { items: 0 }

export default api()
  .get('/items', async () => {
    calls.items++

    return { items: ['a', 'b'], locale: await renderLocale() }
  })
  .get('/boom', () => {
    throw new Error('the route broke')
  })
  .get('/evil', () => ({ text: '</script><script>globalThis.pwned = 1</script><!--' }))
`,
  'src/api/private/index.ts': `import { api } from 'kay/server'

export default api().get('/me', ({ request }) => ({ user: request.headers.get('x-user') }))
`,
  'src/api/private/_guard.ts': `import { guard } from 'kay'

export default guard(({ request, deny }) => {
  if (request.headers.get('x-user') === null)
    deny(401, 'Sign in first')
})
`,
  'src/components/Items.kay': `---
import { resource } from 'kay'
import data from '../api/data'

const { initial } = props<{ initial?: { items: string[], locale: string } }>()
const list = resource(data, '/items', initial === undefined ? undefined : { initial })
---
p.status {list.status()}
p.items {list.value()?.items.join(',')}
p.locale {list.value()?.locale}
`,
  'src/components/Other.kay': `---
import { resource } from 'kay'
import data from '../api/data'

const list = resource(data, '/boom')
const evil = resource(data, '/evil')
---
p.boom {list.status()}
p.evil {evil.status()}: {evil.value()?.text}
`,
  'src/components/Me.kay': `---
import { resource } from 'kay'
import priv from '../api/private'

const me = resource(priv, '/me')
---
p.me {me.status()}: {me.value()?.user}
`,
  'src/routes/index.kay': `---
import Items from '../components/Items.kay'
---
Items
`,
  'src/routes/two.kay': `---
import Items from '../components/Items.kay'
---
Items
Items
`,
  'src/routes/bare.kay': `p Nothing to read
`,

  'src/routes/fixed.kay': `---
import Items from '../components/Items.kay'
---
Items(initial={{ items: ['x'], locale: 'given' }})
`,
  'src/routes/other.kay': `---
import Other from '../components/Other.kay'
---
Other
`,
  'src/routes/me.kay': `---
import Me from '../components/Me.kay'
---
Me
`,
}

await Promise.all(Object.entries(files).map(async ([path, source]) => {
  await mkdir(dirname(join(dir, path)), { recursive: true })
  await writeFile(join(dir, path), source)
}))

const dirs = { routes: relative(process.cwd(), join(dir, 'src/routes')), api: relative(process.cwd(), join(dir, 'src/api')), components: relative(process.cwd(), join(dir, 'src/components')) }
const sites = {
  plain: await testSite({ dirs, styles: true }),
  dev: await testSite({ dirs, dev: true, styles: true }),
  mounted: await testSite({ dirs, base: '/blog', trailingSlash: 'always', styles: true }),
  localized: await testSite({ dirs, styles: true, i18n: { locales: ['en', 'fr'], defaultLocale: 'en', messages: join(dir, 'src/messages') } }),
}
const { calls } = await import(join(dir, 'src/api/data.ts')) as { calls: { items: number } }
const SCRIPT = /<script type="application\/json" data-kay-resources>(.*?)<\/script>/s

afterAll(async () => {
  await Promise.all(Object.values(sites).map(async site => site.close()))
})

async function page(site: typeof sites.plain, path: string, headers: Record<string, string> = {}): Promise<string> {
  const response = await site.fetch(path, { headers })

  expect(response.status).toBe(200)

  return (await response.text()).replaceAll('<!--[-->', '').replaceAll('<!--]-->', '')
}

function seeds(html: string): Record<string, { value: unknown, proof: string | null }> | undefined {
  const text = SCRIPT.exec(html)?.[1]

  return text === undefined ? undefined : JSON.parse(text) as Record<string, { value: unknown, proof: string | null }>
}

describe('the server render of resource()', () => {
  it('runs the route in process and renders the island ready, handing the browser the value', async () => {
    const before = calls.items
    const html = await page(sites.plain, '/')

    expect(html).toContain('<p class="status">ready</p>')
    expect(html).toContain('<p class="items">a,b</p>')
    expect(calls.items - before).toBe(1)
    expect(seeds(html)).toEqual({ '/api/data/items': { value: { items: ['a', 'b'], locale: 'en' }, proof: null } })
  })

  it('renders the same in development', async () => {
    const html = await page(sites.dev, '/')

    expect(html).toContain('<p class="status">ready</p>')
    expect(seeds(html)?.['/api/data/items']?.value).toEqual({ items: ['a', 'b'], locale: 'en' })
  })

  it('asks the route under the base, whichever way the page is spelled', async () => {
    const html = await page(sites.mounted, '/blog/')

    expect(html).toContain('<p class="items">a,b</p>')
    expect(seeds(html)?.['/api/data/items']).toBeDefined()
  })

  it('asks the route in the language of the page', async () => {
    expect(await page(sites.localized, '/fr')).toContain('<p class="locale">fr</p>')
    expect(await page(sites.localized, '/')).toContain('<p class="locale">en</p>')
  })

  it('asks one request for islands sharing a route', async () => {
    const before = calls.items
    const html = await page(sites.plain, '/two')

    expect(html.match(/<p class="status">ready<\/p>/g)?.length).toBe(2)
    expect(calls.items - before).toBe(1)
    expect(Object.keys(seeds(html) ?? {})).toEqual(['/api/data/items'])
  })

  it('renders an initial value ready with no request and no seed', async () => {
    const before = calls.items
    const html = await page(sites.plain, '/fixed')

    expect(html).toContain('<p class="items">x</p>')
    expect(html).toContain('<p class="locale">given</p>')
    expect(calls.items).toBe(before)
    expect(seeds(html)).toBeUndefined()
  })

  it('leaves the island loading when the route throws, and renders the others', async () => {
    const html = await page(sites.plain, '/other')

    expect(html).toContain('<p class="boom">loading</p>')
    expect(html).toContain('<p class="evil">ready: &lt;/script>')
  })

  it('cannot be broken out of by a value holding a closing script tag', async () => {
    const html = await page(sites.plain, '/other')
    const script = SCRIPT.exec(html)?.[1] ?? ''

    expect(script).not.toContain('</script')
    expect(script).not.toContain('<!--')
    expect(seeds(html)?.['/api/data/evil']?.value).toEqual({ text: '</script><script>globalThis.pwned = 1</script><!--' })
    expect(html).not.toContain('<script>globalThis.pwned')
  })

  it('runs the route\'s guard as the visitor: a refusal leaves the island loading and nothing of it in the page', async () => {
    const refused = await page(sites.plain, '/me')

    expect(refused).toContain('<p class="me">loading: </p>')
    expect(refused).not.toContain('Sign in first')
    expect(seeds(refused)).toBeUndefined()

    const admitted = await page(sites.plain, '/me', { 'x-user': 'ada' })

    expect(admitted).toContain('<p class="me">ready: ada</p>')
    expect(seeds(admitted)?.['/api/private/me']?.value).toEqual({ user: 'ada' })
  })

  it('adds no seed script to a page that reads no resource', async () => {
    expect(seeds(await page(sites.plain, '/bare'))).toBeUndefined()
  })

  it('does not share the page of a visitor with a cookie', async () => {
    const response = await sites.plain.fetch('/', { headers: { cookie: 'a=b' } })

    expect(response.headers.get('cache-control') ?? '').not.toContain('public')
  })
})

describe('resource() in the browser', () => {
  let served: ReturnType<typeof spyOn<typeof globalThis, 'fetch'>>
  const gates: PromiseWithResolvers<unknown>[] = []
  let answers = 0
  const fake = { [API_MOUNT]: '/api/fake' }
  const realDocument = globalThis.document
  const realWindow = globalThis.window
  const listeners = new Map<string, Set<() => void>>()
  const hidden = { value: false }

  async function until(ready: () => boolean): Promise<void> {
    for (let waited = 0; !ready(); waited += 2) {
      if (waited > 2000)
        throw new Error('timed out')

      await Bun.sleep(2)
    }
  }

  const answer = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } })

  beforeAll(() => {
    const add = (type: string, run: () => void) => void (listeners.get(type) ?? listeners.set(type, new Set()).get(type)!).add(run)
    const remove = (type: string, run: () => void) => void listeners.get(type)?.delete(run)

    globalThis.document = { querySelector: () => null, querySelectorAll: () => [], get hidden() {
      return hidden.value
    }, addEventListener: add, removeEventListener: remove, readyState: 'complete' } as unknown as Document
    globalThis.window = { addEventListener: add, removeEventListener: remove } as unknown as Window & typeof globalThis
    served = spyOn(globalThis, 'fetch').mockImplementation((async () => {
      answers++

      return gates.length > 0 ? answer(await gates.shift()!.promise) : answer({ n: answers })
    }) as unknown as typeof fetch)
  })

  afterAll(() => {
    served.mockRestore()
    globalThis.document = realDocument
    globalThis.window = realWindow
  })

  function emit(type: string): void {
    for (const run of listeners.get(type) ?? [])
      run()
  }

  it('shares one request and one value between resources reading one route and arguments', async () => {
    const before = answers
    const [one, two] = root(() => [read(fake, '/x', { query: { a: 1 } }), read(fake, '/x', { query: { a: 1 } })] as const)
    const other = root(() => read(fake, '/x', { query: { a: 2 } }))

    await until(() => one.status() === 'ready' && other.status() === 'ready')

    expect(answers - before).toBe(2)
    expect(two.value()).toEqual(one.value())

    one.mutate({ n: 99 }, { refresh: false })
    expect(two.value()).toEqual({ n: 99 })
    expect(other.value()).not.toEqual({ n: 99 })
  })

  it('shares by key when given one', async () => {
    const before = answers
    const [one, two] = root(() => [read(fake, '/y', { key: 'rooms' }), read(fake, '/z', { key: 'rooms' })] as const)

    await until(() => two.status() === 'ready')

    expect(answers - before).toBe(1)
    expect(one.value()).toEqual(two.value())
  })

  it('starts ready with initial and asks nothing until refresh', async () => {
    const before = answers
    const found = root(() => read(fake, '/i', { initial: { n: 0 } }))

    flush()
    await Bun.sleep(5)

    expect(found.status()).toBe('ready')
    expect(found.value()).toEqual({ n: 0 })
    expect(answers).toBe(before)

    found.refresh()
    await until(() => (found.value() as { n: number }).n !== 0)

    expect(answers - before).toBe(1)
  })

  it('hydrates ready with the value the server rendered, asking nothing', async () => {
    const before = answers
    const script = { textContent: JSON.stringify({ '/api/fake/seeded': { value: { n: 'from the server' }, proof: null } }) } as unknown as Element

    const browser = globalThis.document

    globalThis.document = Object.create(browser, { querySelectorAll: { value: () => [script] } }) as Document
    hydrationStarted()

    const found = root(() => read(fake, '/seeded'))

    hydrationEnded()
    globalThis.document = browser
    flush()
    await Bun.sleep(5)

    expect(found.status()).toBe('ready')
    expect(found.value()).toEqual({ n: 'from the server' })
    expect(answers).toBe(before)
  })

  it('mutate sets the value and asks again; an older request in flight never overwrites it', async () => {
    const found = root(() => read(fake, '/m'))

    await until(() => found.status() === 'ready')

    const old = Promise.withResolvers<unknown>()
    const settled = Promise.withResolvers<unknown>()

    gates.push(old, settled)
    found.refresh()
    expect(found.status()).toBe('loading')
    found.mutate({ n: 'mutated' })
    expect(found.value()).toEqual({ n: 'mutated' })
    expect(found.status()).toBe('ready')

    old.resolve({ n: 'older' })
    await Bun.sleep(10)
    expect(found.value()).toEqual({ n: 'mutated' })

    settled.resolve({ n: 'settled' })
    await until(() => (found.value() as { n: unknown }).n === 'settled')
    expect(found.pending()).toBe(false)

    found.mutate((current: unknown) => ({ n: `${(current as { n: string }).n}!` }), { refresh: false })
    expect(found.value()).toEqual({ n: 'settled!' })
  })

  it('revalidates on focus, on reconnect and on a duration, quietly, and stops with the component', async () => {
    const signalled = signal(0)
    const [found, dispose] = root(done => [read(fake, '/r', () => ({ query: { v: signalled() }, revalidate: ['focus', 'reconnect', '20ms'] })), done] as const)

    await until(() => found.status() === 'ready')

    const asked = async (trigger: () => void) => {
      const before = answers

      trigger()
      expect(found.status()).toBe('ready')
      await until(() => answers > before)
      await until(() => !found.pending())
    }

    await asked(() => emit('focus'))
    await asked(() => emit('online'))
    await asked(() => undefined)
    hidden.value = true
    await Bun.sleep(5)
    const quiet = answers

    await Bun.sleep(60)
    expect(answers).toBe(quiet)
    hidden.value = false

    dispose()

    const stopped = answers

    emit('focus')
    emit('online')
    emit('visibilitychange')
    await Bun.sleep(60)
    expect(answers).toBe(stopped)
    expect([...listeners.values()].reduce((sum, set) => sum + set.size, 0)).toBe(0)
  })
})
