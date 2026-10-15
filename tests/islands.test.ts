import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { plugin } from 'bun'
import { afterAll, beforeAll, describe, expect, it, spyOn } from 'bun:test'
import { kay } from '../src/build/plugin'
import { collectHead, head } from '../src/runtime/head'
import { child } from '../src/runtime/html'
import { island, IslandPropsError } from '../src/runtime/island.server'
import { trustHtml } from '../src/runtime/sanitize'
import { HYDRATION_SCRIPT } from '../src/server/hydration'

await plugin(kay())

const fixtures = join(import.meta.dir, 'fixtures/islands')

let outdir: string
let pageHtml: string
let Page: () => unknown

beforeAll(async () => {
  Page = (await import(join(fixtures, 'page.kay')) as { default: () => unknown }).default

  pageHtml = child(Page())
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
    expect(pageHtml).toContain('<slot data-component="tests/fixtures/islands/counter.kay" data-props="[{&quot;start&quot;:1},2]"><button>Count <!--[-->2<!--]--></button></slot>')
    expect(pageHtml).toContain('<p>after</p>')
  })

  it('keeps collecting the page head after an island, so head tags registered later still land', () => {
    const { head: rendered } = collectHead(() => child([Page(), head([{ tag: 'title', props: { children: 'After the island' } }])]))

    expect(rendered.html).toContain('After the island</title>')
  })

  it('marks an island hydrating once visible and keeps its hydrate prop out of its props', () => {
    expect(pageHtml).toContain('data-props="[{&quot;start&quot;:1},5]" data-hydrate="visible">')
  })

  it('names the prop an island cannot serialize, however deep it sits', () => {
    class Score {
      constructor(readonly value: number) {}
    }
    const Rich = island('rich.kay', (_props: { scores: Map<string, unknown> }) => null)

    expect(() => child(Rich({ scores: new Map([['x', new Score(1)]]) }))).toThrow(new IslandPropsError('rich.kay is interactive, so it renders as an island, and its props cannot reach the browser: Cannot stringify arbitrary non-POJOs at .scores.get("x")'))
  })

  it('hydrates the island in place and keeps it reactive, a visible one once its markup scrolls into view', async () => {
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

    // eslint-disable-next-line no-new-func -- runs the inline hydration script, which happy-dom does not execute from markup
    (new Function(HYDRATION_SCRIPT) as () => void)()
    document.body.innerHTML = pageHtml
    const button = document.querySelector('slot button')!
    const { ready } = await import(join(outdir, 'client.js')) as { ready: Promise<void> }

    await ready
    expect(document.querySelector('slot button')).toBe(button)

    button.dispatchEvent(new Event('click', { bubbles: true }))
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(button.textContent).toBe('Count 3')

    const [lazy] = observed
    const lazyIsland = document.querySelector('slot[data-hydrate="visible"]')!
    const lazyButton = lazyIsland.querySelector('button')!

    // The wrapper has no box, so what scrolls into view is its markup.
    expect(observed.map(({ target }) => target)).toEqual([...lazyIsland.children])
    lazy!.callback([{ isIntersecting: true, target: lazy!.target } as IntersectionObserverEntry], {} as IntersectionObserver)
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(disconnected).toBe(1)
    expect(lazyIsland.querySelector('button')).toBe(lazyButton)
    lazyButton.dispatchEvent(new Event('click', { bubbles: true }))
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(lazyButton.textContent).toBe('Count 6')

    // happy-dom has no requestIdleCallback, so an idle island waits for the timer standing in for it.
    const idleButton = document.querySelector('slot[data-hydrate="idle"] button')!

    await new Promise(resolve => setTimeout(resolve, 250))
    idleButton.dispatchEvent(new Event('click', { bubbles: true }))
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(idleButton.textContent).toBe('Count 8')
  })

  it('renders an await block in an island pending on the server, then resolves it in the hydrated island', async () => {
    expect(pageHtml).toContain('<section class="greeting"><!--[--><p class="wait">Waiting</p><!--]-->')
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

  it('replays a click made before its island hydrated, once it has, and only once', async () => {
    // eslint-disable-next-line no-new-func -- runs the inline hydration script, which happy-dom does not execute from markup
    (new Function(HYDRATION_SCRIPT) as () => void)()
    document.body.innerHTML = pageHtml
    const button = document.querySelector('slot button')!

    button.dispatchEvent(new Event('click', { bubbles: true }))
    expect(button.textContent).toBe('Count 2')

    const { hydrateAgain } = await import(join(outdir, 'client.js')) as { hydrateAgain: () => Promise<void> }

    await hydrateAgain()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(document.querySelector('slot button')).toBe(button)
    expect(button.textContent).toBe('Count 3')
    expect((globalThis as { _$K?: Event[] })._$K).toEqual([])
  })

  it('drops the clicks made on an island that will never hydrate', async () => {
    const error = spyOn(console, 'error').mockImplementation(() => undefined)

    try {
      // eslint-disable-next-line no-new-func -- runs the inline hydration script, which happy-dom does not execute from markup
      (new Function(HYDRATION_SCRIPT) as () => void)()
      document.body.innerHTML = '<slot data-component="gone.kay"><button>Gone</button></slot><section><slot data-component="tests/fixtures/islands/counter.kay" data-hydrate="idle"><button>Later</button></slot></section>'

      for (const button of document.querySelectorAll('button'))
        button.dispatchEvent(new Event('click', { bubbles: true }))

      const queue = (globalThis as { _$K?: Event[] })._$K!
      const { hydrateAgain } = await import(join(outdir, 'client.js')) as { hydrateAgain: () => Promise<void> }

      // As a page swap takes an island away before it hydrated.
      document.querySelector('section')!.remove()

      await hydrateAgain()
      expect(queue).toEqual([])
    }
    finally {
      error.mockRestore()
    }
  })

  it('keeps the last 50 events queued for an island that has not hydrated, and one input event per run on the same field', () => {
    // eslint-disable-next-line no-new-func -- runs the inline hydration script, which happy-dom does not execute from markup
    (new Function(HYDRATION_SCRIPT) as () => void)()
    document.body.innerHTML = '<slot data-component="a.kay" data-hydrate="visible"><button>A</button></slot><slot data-component="b.kay" data-hydrate="visible"><button>B</button></slot><slot data-component="c.kay" data-hydrate="visible"><input></slot>'

    const [button, other, input] = [...document.querySelectorAll('button, input')]
    const queue = (globalThis as { _$K?: Event[] })._$K!

    for (let i = 0; i < 500; i++)
      button!.dispatchEvent(Object.assign(new Event('click', { bubbles: true }), { n: i }))

    // The other island still queues, and typing queues its last input alone.
    other!.dispatchEvent(new Event('click', { bubbles: true }))

    for (let i = 0; i < 500; i++)
      input!.dispatchEvent(Object.assign(new Event('input', { bubbles: true }), { n: i }))

    expect(queue.filter(event => event.target === button)).toHaveLength(50)
    expect(queue.filter(event => event.target === other)).toHaveLength(1)
    expect(queue.filter(event => event.target === input)).toHaveLength(1)
    expect((queue.find(event => event.target === input) as unknown as { n: number }).n).toBe(499)
    expect(queue.filter(event => event.target === button).map(event => (event as unknown as { n: number }).n)).toEqual(Array.from({ length: 50 }, (_, i) => 450 + i))

    // A click between two inputs keeps both, and changes merge as inputs do.
    input!.dispatchEvent(new Event('click', { bubbles: true }))
    input!.dispatchEvent(new Event('input', { bubbles: true }))
    expect(queue.filter(event => event.target === input)).toHaveLength(3)
    input!.dispatchEvent(new Event('change', { bubbles: true }))
    input!.dispatchEvent(new Event('change', { bubbles: true }))
    expect(queue.filter(event => event.target === input && event.type === 'change')).toHaveLength(1)
  })

  it('replays a click made before its island hydrated once its effects ran, as on an island already hydrated', async () => {
    const { default: Mounted } = await import(join(fixtures, 'mounted.kay')) as { default: (props: object) => unknown }

    // eslint-disable-next-line no-new-func -- runs the inline hydration script, which happy-dom does not execute from markup
    (new Function(HYDRATION_SCRIPT) as () => void)()
    document.body.innerHTML = child(Mounted({}))
    const button = document.querySelector('button.mounted')!

    button.dispatchEvent(new Event('click', { bubbles: true }))

    const { hydrateAgain } = await import(join(outdir, 'client.js')) as { hydrateAgain: () => Promise<void> }

    await hydrateAgain()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(button.textContent).toBe('Counted 11')
  })

  it('keeps what was typed and ticked before its island hydrated, the bound signals taking it', async () => {
    const { default: Typed } = await import(join(fixtures, 'typed.kay')) as { default: (props: object) => unknown }

    // eslint-disable-next-line no-new-func -- runs the inline hydration script, which happy-dom does not execute from markup
    (new Function(HYDRATION_SCRIPT) as () => void)()
    document.body.innerHTML = child(Typed({}))
    const name = document.querySelector<HTMLInputElement>('input.name')!
    const agree = document.querySelector<HTMLInputElement>('input.agree')!

    name.value = 'Ada'
    name.dispatchEvent(new Event('input', { bubbles: true }))
    agree.checked = true
    agree.dispatchEvent(new Event('change', { bubbles: true }))

    const { hydrateAgain } = await import(join(outdir, 'client.js')) as { hydrateAgain: () => Promise<void> }

    await hydrateAgain()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(name.value).toBe('Ada')
    expect(agree.checked).toBe(true)
    expect(document.querySelector('form.typed p')!.textContent).toBe('Ada yes')
  })

  it('renders an island afresh, logging an error, when its server markup is not what it builds', async () => {
    const logged = spyOn(console, 'error').mockImplementation(() => undefined)

    document.body.innerHTML = pageHtml.replace('<button>Count <!--[-->2<!--]--></button>', '<em>changed</em>')

    try {
      const { hydrateAgain } = await import(join(outdir, 'client.js')) as { hydrateAgain: () => Promise<void> }

      await hydrateAgain()
      expect(logged).toHaveBeenCalledWith(expect.stringContaining('[kay] island tests/fixtures/islands/counter.kay did not match its server markup'))
      const button = document.querySelector('slot button')!

      expect(document.querySelector('slot em')).toBeNull()
      button.dispatchEvent(new Event('click', { bubbles: true }))
      await new Promise(resolve => setTimeout(resolve, 0))
      expect(button.textContent).toBe('Count 3')
    }
    finally {
      logged.mockRestore()
    }
  })

  it.each([
    ['a pending await block', 'slowpage.kay', 'button.cancel', 'Cancel 1'],
    ['an await on a plain value', 'plainpage.kay', 'button.hi', 'hi Ada 1'],
    ['props holding a Date, a Set, a Map and a bigint', 'richpage.kay', 'button.rich', '2020 1 11 3'],
    ['a generic island', 'richpage.kay', 'button.picker', 'Ada 4'],
    ['text joining constants and signals with nothing between', 'joinedpage.kay', 'button.joined', '2AdatAda2'],
  ])('hydrates %s in an island without a mismatch, its handler working at once', async (_name, file, selector, expected) => {
    const issues: string[] = []
    const warn = spyOn(console, 'warn').mockImplementation((...args) => void issues.push(args.join(' ')))
    const error = spyOn(console, 'error').mockImplementation((...args) => void issues.push(args.join(' ')))
    const { default: Fixture } = await import(join(fixtures, file)) as { default: () => unknown }

    document.body.innerHTML = child(Fixture())
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

  it('renders a static component without hydration markers, and through its hydratable twin inside an island', async () => {
    const issues: string[] = []
    const warn = spyOn(console, 'warn').mockImplementation((...args) => void issues.push(args.join(' ')))
    const error = spyOn(console, 'error').mockImplementation((...args) => void issues.push(args.join(' ')))
    const { default: Fixture } = await import(join(fixtures, 'tallypage.kay')) as { default: () => unknown }

    const html = child(Fixture())

    expect(html).toContain('<main><ul class="badges"><li class="badge">x</li></ul><slot')
    expect(html).toContain('<section class="tally"><!--[--><ul class="badges"><li class="badge">a</li>')
    document.body.innerHTML = html

    const { hydrateAgain } = await import(join(outdir, 'client.js')) as { hydrateAgain: () => Promise<void> }

    await hydrateAgain()
    const button = document.querySelector('button.tally')!

    button.dispatchEvent(new Event('click', { bubbles: true }))
    await new Promise(resolve => setTimeout(resolve, 0))
    warn.mockRestore()
    error.mockRestore()
    expect(document.querySelector('button.tally')).toBe(button)
    expect(button.textContent).toBe('Tally 1')
    expect([...document.querySelectorAll('slot li.badge')].map(item => item.textContent)).toEqual(['a', 'b', 'c'])
    expect(issues).toEqual([])
  })

  it('renders a row\'s template consts on the server, then hydrates them as memos that follow what they read without drawing the row again', async () => {
    const issues: string[] = []
    const warn = spyOn(console, 'warn').mockImplementation((...args) => void issues.push(args.join(' ')))
    const error = spyOn(console, 'error').mockImplementation((...args) => void issues.push(args.join(' ')))
    const { default: Fixture } = await import(join(fixtures, 'pricedpage.kay')) as { default: () => unknown }
    const html = child(Fixture())
    const rows = () => [...document.querySelectorAll('li.product')].map(row => [row.className, row.getAttribute('title'), row.textContent])

    document.body.innerHTML = html
    expect(rows()).toEqual([['product low', '2.50', 'Tea: 2.501 left'], ['product', '9.00', 'Mug: 9.00']])

    const { hydrateAgain } = await import(join(outdir, 'client.js')) as { hydrateAgain: () => Promise<void> }

    await hydrateAgain()
    const first = document.querySelector('li.product')

    document.querySelector('button.rate')!.dispatchEvent(new Event('click', { bubbles: true }))
    await new Promise(resolve => setTimeout(resolve, 0))
    warn.mockRestore()
    error.mockRestore()
    expect(document.querySelector('li.product')).toBe(first)
    expect(rows()).toEqual([['product low', '5.00', 'Tea: 5.001 left'], ['product', '18.00', 'Mug: 18.00']])
    expect(issues).toEqual([])
  })

  it('hydrates an island whose prop the server vouched for, keeping its markup in a spread and dropping a plain string\'s', async () => {
    const { default: Fixture } = await import(join(fixtures, 'vouchedpage.kay')) as { default: (props: { markup: string }) => unknown }
    const html = child(Fixture({ markup: trustHtml('<b>island-vouched-1</b>') }))
    const warn = spyOn(console, 'warn').mockImplementation(() => undefined)

    document.body.innerHTML = html
    expect(document.querySelector('.good')!.innerHTML).toBe('<b>island-vouched-1</b>')
    expect(document.querySelector('.bad')!.innerHTML).toBe('')
    expect(document.querySelector('slot')!.getAttribute('data-props')).toContain('SafeHtml')

    const { hydrateAgain } = await import(join(outdir, 'client.js')) as { hydrateAgain: () => Promise<void> }
    const good = document.querySelector('.good')!

    await hydrateAgain()
    document.querySelector('button.bump')!.dispatchEvent(new Event('click', { bubbles: true }))
    await new Promise(resolve => setTimeout(resolve, 30))
    warn.mockRestore()
    expect(document.querySelector('.good')).toBe(good)
    expect(good.innerHTML).toBe('<b>island-vouched-1</b>')
    expect(document.querySelector('.bad')!.innerHTML).toBe('')
    expect(document.querySelector('button.bump')!.textContent).toBe('Bumped 1')
  })
})
