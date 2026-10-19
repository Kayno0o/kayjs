import type { Mock } from 'bun:test'
import type { NavigationHooks } from '../src/runtime/navigation'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { afterAll, afterEach, beforeAll, describe, expect, it, spyOn } from 'bun:test'
import { stringify } from 'devalue'

const MODULES = ['navigate-api', 'hydrate-when', 'focus', 'live-props'] as const

type Chunk = typeof MODULES[number]
type Behaviour = 'real' | 'fail' | 'held'

// The plugin is process-wide and a chunk that loaded stays loaded, so this file needs a process of its own (`bun test --parallel` gives each file one) and a chunk is failed or held before anything imports it.
// What each lazy chunk does when something first imports it: loads, fails as with the build unchanged (offline, a dev server restarting), or waits for `release()` and then does what the test left it as. A chunk that loaded stays loaded, so the tests that need one to load come last.
const behaviours = new Map<Chunk, Behaviour>(MODULES.map(name => [name, 'real']))
let release: () => void = () => undefined
let gate = new Promise<void>(resolve => (release = resolve))

function holdLoads(): void {
  gate = new Promise<void>(resolve => (release = resolve))
}

function behave(name: Chunk, behaviour: Behaviour): void {
  behaviours.set(name, behaviour)
}

Bun.plugin({
  name: 'chunk-failures',
  setup(build) {
    build.onLoad({ filter: new RegExp(`/src/runtime/(${MODULES.join('|')})\\.ts$`) }, async ({ path }) => {
      const name = MODULES.find(candidate => path.endsWith(`/${candidate}.ts`))!

      if (behaviours.get(name) === 'held')
        await gate

      if (behaviours.get(name) === 'fail')
        throw new Error(`Failed to fetch dynamically imported module: ${name}`)

      return { contents: await Bun.file(path).text(), loader: 'ts' }
    })
  },
})

let navigation: typeof import('../src/runtime/navigation').navigation
let actionStub: typeof import('../src/runtime/action').actionStub
let showRefusal: typeof import('../src/runtime/swap-refusal').showRefusal

beforeAll(async () => {
  GlobalRegistrator.register({ url: 'http://localhost/page' })

  ;({ navigation } = await import('../src/runtime/navigation'))
  ;({ actionStub } = await import('../src/runtime/action'))
  ;({ showRefusal } = await import('../src/runtime/swap-refusal'))
})

afterAll(async () => {
  for (const name of MODULES)
    behave(name, 'real')

  await GlobalRegistrator.unregister()
})

// The client imports navigate-api statically in source (the build splits it), so it loads after the tests that need that chunk to be lazy.
async function hydrated(): Promise<typeof import('../src/runtime/client')> {
  return import('../src/runtime/client')
}

async function settle(): Promise<void> {
  for (let turn = 0; turn < 20; turn++)
    await Bun.sleep(0)
}

describe('a page whose navigate-api chunk fails to load with the build unchanged', () => {
  let fetched: Mock<typeof fetch>
  let reloaded: Mock<typeof location.reload>
  let assigned: Mock<typeof location.assign>

  const answer = (response: Response) => {
    fetched = spyOn(globalThis, 'fetch').mockImplementation((async () => response.clone()) as unknown as typeof fetch)
    reloaded = spyOn(location, 'reload').mockImplementation(() => undefined)
    assigned = spyOn(location, 'assign').mockImplementation(() => undefined)
    // As `startNavigation` registers it.
    navigation.hooks = {} as NavigationHooks
    navigation.released = false
    delete navigation.stale
    sessionStorage.clear()
    document.body.innerHTML = ''
    document.head.innerHTML = ''
  }

  afterEach(() => {
    delete navigation.hooks
    fetched.mockRestore()
    reloaded.mockRestore()
    assigned.mockRestore()
  })

  it('loads the page whole after an action, so its effect shows', async () => {
    answer(new Response(stringify('ok')))
    behave('navigate-api', 'fail')

    const call = actionStub('/_kay/action/test/refresh') as unknown as (input: object) => Promise<unknown>

    expect(await call({})).toBe('ok')
    await settle()

    expect(reloaded).toHaveBeenCalledTimes(1)
  })

  it('keeps a page holding what was typed, which the next link then loads in full', async () => {
    answer(new Response(stringify('ok')))
    behave('navigate-api', 'fail')
    document.body.innerHTML = '<input value="a">'
    document.querySelector('input')!.value = 'typed'

    const call = actionStub('/_kay/action/test/refresh') as unknown as (input: object) => Promise<unknown>

    await call({})
    await settle()

    expect(reloaded).not.toHaveBeenCalled()
    expect(navigation.stale).toBe(true)
  })

  it('reloads once a minute at most, so a chunk missing for good cannot loop the page', async () => {
    answer(new Response(stringify('ok')))
    behave('navigate-api', 'fail')

    const call = actionStub('/_kay/action/test/refresh') as unknown as (input: object) => Promise<unknown>

    await call({})
    await settle()
    await call({})
    await settle()

    expect(reloaded).toHaveBeenCalledTimes(1)
    expect(navigation.stale).toBe(true)
  })

  it('keeps a document that answered a form post, which a reload would post again', async () => {
    answer(new Response(stringify('ok')))
    behave('navigate-api', 'fail')
    document.head.innerHTML = '<meta name="kay-posted">'

    const call = actionStub('/_kay/action/test/refresh') as unknown as (input: object) => Promise<unknown>

    await call({})
    await settle()

    expect(reloaded).not.toHaveBeenCalled()
  })

  it('keeps the page when the call says refresh: false', async () => {
    answer(new Response(stringify('ok')))
    behave('navigate-api', 'fail')

    const call = actionStub('/_kay/action/test/refresh') as unknown as (input: object, options: object) => Promise<unknown>

    await call({}, { refresh: false })
    await settle()

    expect(reloaded).not.toHaveBeenCalled()
  })

  it('gives way to a link followed while its code loaded, so the refresh does not pull the visitor back', async () => {
    answer(new Response(stringify('ok')))
    holdLoads()
    behave('navigate-api', 'held')

    const call = actionStub('/_kay/action/test/refresh') as unknown as (input: object) => Promise<unknown>

    await call({})
    await settle()
    navigation.visits = (navigation.visits ?? 0) + 1
    behave('navigate-api', 'fail')
    release()
    await settle()

    expect(reloaded).not.toHaveBeenCalled()
  })

  it('loads the page an action redirects to, asking the leave guards as a site without the swap does', async () => {
    answer(new Response(null, { status: 200, headers: { 'x-kay-redirect': '/elsewhere' } }))
    behave('navigate-api', 'fail')

    const call = actionStub('/_kay/action/test/redirect') as unknown as (input: object) => Promise<unknown>

    // The page goes away, so the call never settles.
    void call({})
    await settle()

    expect(assigned).toHaveBeenCalledTimes(1)
    expect(String(assigned.mock.calls[0]![0])).toBe(new URL('/elsewhere', location.href).href)
  })

  it('gives way to a swap that started while its code loaded, when the code does load', async () => {
    answer(new Response(stringify('ok')))
    holdLoads()
    behave('navigate-api', 'held')

    const call = actionStub('/_kay/action/test/refresh') as unknown as (input: object) => Promise<unknown>

    await call({})
    await settle()
    navigation.visits = (navigation.visits ?? 0) + 1
    behave('navigate-api', 'real')
    release()
    await settle()

    // Only the call itself was fetched: the refresh would have asked for the page.
    expect(fetched).toHaveBeenCalledTimes(1)
    expect(reloaded).not.toHaveBeenCalled()
  })
})

describe('an island hydrating on visible or idle, hydrate-when failing to load with the build unchanged', () => {
  it('hydrates at once instead of staying inert', async () => {
    behave('hydrate-when', 'fail')

    const loaded: string[] = []
    const registry = Object.fromEntries(['a', 'b'].map(id => [`${id}.kay`, async () => {
      loaded.push(id)

      return { default: () => null }
    }]))

    document.body.innerHTML = '<slot data-component="a.kay" data-props="[{}]" data-hydrate="visible"></slot><slot data-component="b.kay" data-props="[{}]" data-hydrate="idle"></slot>'
    await (await hydrated()).hydrateIslands(registry)
    await settle()

    expect(loaded.sort()).toEqual(['a', 'b'])
  })
})

describe('a persistent island, live-props failing to load with the build unchanged', () => {
  it('is dropped like one with a missing chunk, its failure reported', async () => {
    behave('live-props', 'fail')

    let rendered = false
    const registry = {
      'p.kay': async () => ({ default: () => {
        rendered = true

        return null
      } }),
    }

    document.body.innerHTML = '<slot data-component="p.kay" data-props="[{}]" data-persist=""></slot>'
    await expect((await hydrated()).hydrateIslands(registry)).rejects.toThrow('live-props')
    expect(rendered).toBe(false)
  })
})

describe('a refused form, focus failing to load with the build unchanged', () => {
  it('is announced as one with no invalid field, and keeps the focus on the control that posted it', async () => {
    behave('focus', 'fail')
    document.body.innerHTML = '<form aria-describedby="note"><input aria-invalid="true"><button>Save</button></form><p id="note">Check the fields</p>'

    const announced: string[] = []
    const form = document.querySelector('form')!

    expect(await showRefusal(form, 1, text => announced.push(text))).toBe(true)
    expect(announced).toEqual(['Check the fields'])
    expect(document.activeElement).toBe(form.elements[1]!)
  })
})
