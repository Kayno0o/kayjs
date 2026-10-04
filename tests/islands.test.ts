import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { generateHydrationScript, renderToString, useHead } from '@solidjs/web'
import { plugin } from 'bun'
import { afterAll, beforeAll, describe, expect, it, spyOn } from 'bun:test'
import { kay } from '../src/build/plugin'
import { island, IslandPropsError } from '../src/runtime/island.server'

plugin(kay())

const fixtures = join(import.meta.dir, 'fixtures/islands')
const HYDRATION_SCRIPT = /<script>([\s\S]*?)<\/script>/

let outdir: string
let pageHtml: string
let Page: () => unknown

beforeAll(async () => {
  Page = (await import(join(fixtures, 'page.kay')) as { default: () => unknown }).default

  pageHtml = renderToString(() => Page())
  outdir = await mkdtemp(join(tmpdir(), 'kay-islands-'))
  const build = await Bun.build({ entrypoints: [join(fixtures, 'client.ts')], outdir, target: 'browser', splitting: true, plugins: [kay()] })

  if (!build.success)
    throw new AggregateError(build.logs, 'client build failed')

  GlobalRegistrator.register()
})

afterAll(async () => {
  await GlobalRegistrator.unregister()
  await rm(outdir, { recursive: true, force: true })
})

describe('islands', () => {
  it('server-renders static markup with the interactive component as an island root', () => {
    expect(pageHtml).toContain('<h1>Static title</h1>')
    expect(pageHtml).toContain('<kay-island data-component="tests/fixtures/islands/counter.kay" data-render-id="k')
    expect(pageHtml).toContain('data-props="[{&quot;start&quot;:1},2]"')
    expect(pageHtml).toContain('Count <!--$-->2<!--/-->')
    expect(pageHtml).toContain('<p>after</p>')
  })

  it('keeps the page render context after an island, so head tags registered later still land', () => {
    let head = ''

    renderToString(() => [Page(), useHead({ tag: 'title', props: { children: 'After the island' } })], { noScripts: true, onHead: (html) => {
      head = html
    } })
    expect(head).toContain('After the island</title>')
  })

  it('marks an island hydrating once visible and keeps its hydrate prop out of its props', () => {
    expect(pageHtml).toContain('data-props="[{&quot;start&quot;:1},5]" data-hydrate="visible">')
  })

  it('names the prop an island cannot serialize, however deep it sits', () => {
    class Score {
      constructor(readonly value: number) {}
    }
    const Rich = island('rich.kay', (_props: { scores: Map<string, unknown> }) => null)

    expect(() => renderToString(() => Rich({ scores: new Map([['x', new Score(1)]]) }))).toThrow(new IslandPropsError('rich.kay is interactive, so it renders as an island, and its props cannot reach the browser: Cannot stringify arbitrary non-POJOs at .scores.get("x")'))
  })

  it('hydrates the island in place and keeps it reactive, a visible one once it scrolls into view', async () => {
    const observed: { callback: IntersectionObserverCallback, target: Element }[] = []
    let disconnected = 0

    globalThis.IntersectionObserver = class {
      constructor(private readonly callback: IntersectionObserverCallback) {}
      observe(target: Element) {
        observed.push({ callback: this.callback, target })
      }

      disconnect() {
        disconnected++
      }
    } as unknown as typeof IntersectionObserver

    // The inline hydration script sets up the global the client runtime expects before any island hydrates.
    // Solid's bootstrap assigns `_$HY` on globalThis, which outlives happy-dom's window between test files.
    delete (globalThis as { _$HY?: unknown })._$HY
    // eslint-disable-next-line no-new-func -- runs Solid's own bootstrap script, which happy-dom does not execute from markup
    new Function(HYDRATION_SCRIPT.exec(generateHydrationScript())![1]!)()
    document.body.innerHTML = pageHtml
    const button = document.querySelector('kay-island button')!
    const { ready } = await import(join(outdir, 'client.js')) as { ready: Promise<void> }

    await ready
    expect(document.querySelector('kay-island button')).toBe(button)

    button.dispatchEvent(new Event('click', { bubbles: true }))
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(button.textContent).toBe('Count 3')

    const [lazy] = observed
    const lazyButton = lazy!.target.querySelector('button')!

    expect(observed).toHaveLength(1)
    lazy!.callback([{ isIntersecting: true, target: lazy!.target } as IntersectionObserverEntry], {} as IntersectionObserver)
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(disconnected).toBe(1)
    expect(lazy!.target.querySelector('button')).toBe(lazyButton)
    lazyButton.dispatchEvent(new Event('click', { bubbles: true }))
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(lazyButton.textContent).toBe('Count 6')

    // happy-dom has no requestIdleCallback, so an idle island waits for the timer standing in for it.
    const idleButton = document.querySelector('kay-island[data-hydrate="idle"] button')!

    await new Promise(resolve => setTimeout(resolve, 250))
    idleButton.dispatchEvent(new Event('click', { bubbles: true }))
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(idleButton.textContent).toBe('Count 8')
  })

  it('renders an await block in an island pending on the server, then resolves it in the hydrated island', async () => {
    expect(pageHtml).toMatch(/<p _hk=\S+ class="wait">Waiting<\/p>/)
    const section = document.querySelector('section.greeting')!
    const button = section.querySelector('button')!

    await new Promise(resolve => setTimeout(resolve, 20))
    expect(document.querySelector('section.greeting')).toBe(section)
    expect(section.querySelector('p.text')?.textContent).toBe('Hello Ada')
    expect(section.querySelector('p.wait')).toBeNull()
    button.dispatchEvent(new Event('click', { bubbles: true }))
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(button.textContent).toBe('Clicked 1')
  })

  it.each([
    ['a pending await block', 'slowpage.kay', 'button.cancel', 'Cancel 1'],
    ['an await on a plain value', 'plainpage.kay', 'button.hi', 'hi Ada 1'],
    ['props holding a Date, a Set, a Map and a bigint', 'richpage.kay', 'button.rich', '2020 1 11 3'],
  ])('hydrates %s in an island without a key miss, its handler working at once', async (_name, file, selector, expected) => {
    const issues: string[] = []
    const warn = spyOn(console, 'warn').mockImplementation((...args) => void issues.push(args.join(' ')))
    const error = spyOn(console, 'error').mockImplementation((...args) => void issues.push(args.join(' ')))
    const { default: Fixture } = await import(join(fixtures, file)) as { default: () => unknown }

    delete (globalThis as { _$HY?: unknown })._$HY
    // eslint-disable-next-line no-new-func -- runs Solid's own bootstrap script, which happy-dom does not execute from markup
    new Function(HYDRATION_SCRIPT.exec(generateHydrationScript())![1]!)()
    document.body.innerHTML = renderToString(() => Fixture())
    expect(document.querySelector('script')).toBeNull()

    const { hydrateAgain } = await import(join(outdir, 'client.js')) as { hydrateAgain: () => Promise<void> }

    await hydrateAgain()
    const button = document.querySelector(selector)!

    button.dispatchEvent(new Event('click', { bubbles: true }))
    await new Promise(resolve => setTimeout(resolve, 0))
    warn.mockRestore()
    error.mockRestore()
    expect(document.querySelector(selector)).toBe(button)
    expect(button.textContent).toBe(expected)
    expect(issues).toEqual([])
  })
})
