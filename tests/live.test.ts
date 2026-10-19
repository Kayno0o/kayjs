import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Database } from 'bun:sqlite'
import { afterAll, beforeAll, describe, expect, it, spyOn } from 'bun:test'
import { kay } from '../src/build/plugin'
import { check } from '../src/check'
import { flush, root, signal } from '../src/runtime'
import { ApiError, call, dispatch, openSocket, readEvents, resource, routeUrl, socket, stream } from '../src/runtime/live'
import { encodeValue } from '../src/runtime/wire'
import { apiStubs, scanApi } from '../src/server/api-modules'
import { rooms, sqliteRooms } from '../src/server/rooms'
import { testSite } from '../src/test'
import { fixtureCopy } from './scratch'

// Written into a copy, for this file only: any other test building the repository's root as one project would bundle the island's server imports, missing the fixture's API directory.
const fixture = await fixtureCopy('live')
const apiDir = resolve(fixture, 'src/api')
const components = {
  'src/components/chat.kay': '---\nimport { resource, socket, stream } from \'kay\'\nimport chat from \'../api/chat\'\n\nconst { room } = props<{ room: string }>()\nconst messages = socket(chat, \'/:room\', { params: { room } })\nconst ticks = stream(chat, \'/ticks\', { query: { count: 3 } })\nconst rooms = resource(chat, \'/rooms\', () => ({ query: { prefix: room.slice(0, 1) } }))\n---\nsection\n  p.status {messages.status()}\n  p.last {messages.last()?.text ?? \'Nothing yet\'}\n  p.tick {ticks.last()?.tick ?? 0}\n  p.rooms {rooms.status()}: {rooms.value()?.map(found => found.name).join(\', \')}\n  button(onClick={() => messages.send({ text: \'hello\' })}) Send\n',
  'src/routes/index.kay': '---\nimport Chat from \'../components/chat.kay\'\n---\nh1 Live\nChat(room="general")\na(href="/api/chat/ticks") Ticks\n',
}

await Promise.all(Object.entries(components).map(async ([path, source]) => Bun.write(join(fixture, path), source)))
const reported: unknown[] = []
const site = await testSite({ routes: `${fixture}/src/routes`, api: `${fixture}/src/api`, locals: request => ({ user: request.headers.get('x-user') ?? undefined }), onError: error => void reported.push(error) })
// Imported once the site is up: the modules it mounted, where their routes are served.
const { default: chat } = await import(join(apiDir, 'chat.ts')) as typeof import('./fixtures/live/src/api/chat')
const { default: secret } = await import(join(apiDir, 'private/index.ts')) as typeof import('./fixtures/live/src/api/private/index')
const { default: party } = await import(join(apiDir, 'party.ts')) as typeof import('./fixtures/live/src/api/party')
const { default: notes } = await import(join(apiDir, 'notes.ts')) as typeof import('./fixtures/live/src/api/notes')
const { addNote } = await import(resolve(fixture, 'src/lib/notes.ts')) as typeof import('./fixtures/live/src/lib/notes')

// Polls a condition a request or another process makes true, failing past 2 seconds.
async function until(ready: () => boolean | Promise<boolean>): Promise<void> {
  for (let waited = 0; !await ready(); waited += 5) {
    if (waited > 2_000)
      throw new Error('timed out')

    await Bun.sleep(5)
  }
}

const realSetTimeout = setTimeout

// The backoff timers of a reconnect held until the test fires them, so it waits on what they lead to rather than on their delay; the minute-long fallbacks are the test's own.
function retriesByHand(): { fire: () => void, until: (ready: () => boolean) => Promise<void>, restore: () => void } {
  const pending = new Map<unknown, () => void>()
  const timeouts = spyOn(globalThis, 'setTimeout').mockImplementation(((run: () => void, delay?: number) => {
    const handle = realSetTimeout(() => undefined, 3_600_000)

    handle.unref()

    if (delay !== 60_000)
      pending.set(handle, run)

    return handle
  }) as unknown as typeof setTimeout)
  const clears = spyOn(globalThis, 'clearTimeout').mockImplementation(((handle: Parameters<typeof clearTimeout>[0]) => {
    pending.delete(handle)
  }) as typeof clearTimeout)
  const fire = () => {
    for (const [handle, run] of pending) {
      pending.delete(handle)
      run()
    }
  }

  return {
    fire,
    until: async (ready) => {
      for (let tries = 0; !ready(); tries++) {
        if (tries > 1_000)
          throw new Error('timed out')

        fire()
        await new Promise(resolve => setImmediate(resolve))
      }
    },
    restore: () => {
      timeouts.mockRestore()
      clears.mockRestore()
    },
  }
}

// Lets what a call queued run, for a test asserting something did not happen.
async function turns(count = 10): Promise<void> {
  for (let turn = 0; turn < count; turn++)
    await new Promise(resolve => setImmediate(resolve))
}

// The listeners the targets hold, as their add and remove calls leave them.
function listenerCount(...targets: EventTarget[]): { count: () => number, restore: () => void } {
  const spies = targets.map(target => [spyOn(target, 'addEventListener'), spyOn(target, 'removeEventListener')] as const)

  return {
    count: () => spies.reduce((sum, [added, removed]) => sum + added.mock.calls.length - removed.mock.calls.length, 0),
    restore: () => {
      for (const [added, removed] of spies) {
        added.mockRestore()
        removed.mockRestore()
      }
    },
  }
}

function upgrade(path: string, headers: Record<string, string> = {}): Request {
  return new Request(`http://localhost${path}`, { headers: { 'upgrade': 'websocket', 'connection': 'Upgrade', 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==', 'sec-websocket-version': '13', ...headers } })
}

afterAll(async () => {
  await site.close()
  await rm(fixture, { recursive: true, force: true })
})

describe('API modules', () => {
  it('mounts each module under /api by its path, index as its directory, leaving files starting with _ out', async () => {
    expect(await scanApi(apiDir)).toEqual([
      { file: join(apiDir, 'chat.ts'), mount: '/api/chat', guards: [] },
      { file: join(apiDir, 'index.ts'), mount: '/api', guards: [] },
      { file: join(apiDir, 'notes.ts'), mount: '/api/notes', guards: [] },
      { file: join(apiDir, 'party.ts'), mount: '/api/party', guards: [] },
      { file: join(apiDir, 'private/index.ts'), mount: '/api/private', guards: [{ file: join(apiDir, 'private/_guard.ts'), path: 'private/_guard.ts' }] },
    ])
    expect(await (await site.fetch('/api')).json()).toEqual({ ok: true })
    expect((await site.fetch('/api/_helpers')).status).toBe(404)
  })

  it('runs the guards of the module\'s directory with the app\'s locals, their cookies going out either way', async () => {
    const refused = await site.fetch('/api/private/me')

    expect(refused.status).toBe(401)
    expect(await refused.text()).toBe('Sign in first')
    expect(site.cookies.get('checked')).toBe('private')

    site.cookies.delete('checked')

    const admitted = await site.fetch('/api/private/me', { headers: { 'x-user': 'ada' } })

    expect(await admitted.json()).toEqual({ user: 'ada' })
    expect(site.cookies.get('checked')).toBe('private')
  })

  it('refuses a websocket upgrade from another site, once the guards let it through', async () => {
    expect((await site.handle(upgrade('/api/chat/general', { origin: 'https://evil.example' }))).status).toBe(403)
    expect((await site.handle(upgrade('/api/chat/general', { 'sec-fetch-site': 'cross-site' }))).status).toBe(403)
    expect((await site.handle(upgrade('/api/private/feed', { origin: 'https://evil.example' }))).status).toBe(401)
    expect((await site.handle(upgrade('/api/chat/general', { origin: 'http://localhost' }))).status).not.toBe(403)
  })

  it('refuses a post another site\'s page sends, and lets one with no browser behind it through', async () => {
    const answer = async (headers: Record<string, string>) => site.fetch('/api/chat/answer', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ prompt: 'hi' }) })

    expect((await answer({ origin: 'https://evil.example' })).status).toBe(403)
    expect((await answer({})).status).toBe(200)
  })

  it('opens a typed websocket in process, with the locals and the cookies of the site', async () => {
    const room = site.socket(chat, '/:room', { params: { room: 'general' }, headers: { 'x-user': 'ada' } })

    room.send({ text: 'hello' })

    expect(await room.next()).toEqual({ room: 'general', from: 'ada', text: 'hello' })
    expect(room.status()).toBe('open')
    expect(room.last()).toEqual({ room: 'general', from: 'ada', text: 'hello' })

    room.close()
    expect(room.status()).toBe('closed')
  })

  it('reconnects a websocket the server dropped, sending what was queued meanwhile', async () => {
    const retries = retriesByHand()
    const room = site.socket(chat, '/:room', { params: { room: 'flaky' } })

    try {
      await until(() => room.status() === 'open')
      room.send({ text: 'drop' })
      await until(() => room.status() === 'connecting')
      room.send({ text: 'back' })

      let arrived = false
      const message = (async () => {
        const next = await room.next()

        arrived = true

        return next
      })()

      await until(() => {
        retries.fire()

        return arrived
      })
      expect(await message).toEqual({ room: 'flaky', from: 'anonymous', text: 'back' })
    }
    finally {
      retries.restore()
      room.close()
    }
  })

  it('reads a typed event stream, values crossing as island props do', async () => {
    const ticks = site.stream(chat, '/ticks', { query: { count: 3 } })
    const values = await ticks.finished()

    expect(values.map(value => value.tick)).toEqual([1, 2, 3])
    expect(values[2]!.at).toEqual(new Date(Date.UTC(2026, 0, 3)))
    expect(ticks.status()).toBe('done')
  })

  it('posts a stream\'s body, line breaks in its values kept', async () => {
    const answer = site.stream(chat, '/answer', { method: 'post', body: { prompt: 'two words' } })

    expect(await answer.finished()).toEqual(['two\n', 'words\n'])
  })

  it('ends a stream whose source throws as failed, reporting the error', async () => {
    const logged = spyOn(console, 'error').mockImplementation(() => undefined)
    const broken = site.stream(chat, '/broken')

    expect(await broken.finished()).toEqual([1])
    expect(broken.status()).toBe('failed')
    expect(reported.map(error => (error as Error).message)).toContain('the source broke')
    logged.mockRestore()
  })

  it('ends a stream its guards refuse as failed', async () => {
    const refused = site.stream(secret, '/news')

    expect(await refused.finished()).toEqual([])
    expect(refused.status()).toBe('failed')
  })

  it('renders an island using them on the server without connecting', async () => {
    const page = await site.visit('/')

    expect(page.html).toContain('<p class="status">connecting</p>')
    expect(page.html).toContain('<p class="last">Nothing yet</p>')
    expect(page.html).toMatch(/<p class="rooms">(<!--\[-->)?loading/)
  })

  it('makes no URL on the server, where a page prerendering the island imports the module unmounted', () => {
    expect(() => root((dispose) => {
      socket({} as never, '/' as never)
      dispose()
    })).not.toThrow()
  })

  it('splits lines on a \\r\\n arriving across two chunks once', async () => {
    const chunks = ['event: message\r', '\ndata: [1]\r\n\r\nevent: end\r\ndata:\r\n\r\n']
    const body = new ReadableStream<Uint8Array>({ pull: controller => chunks.length > 0 ? controller.enqueue(new TextEncoder().encode(chunks.shift())) : controller.close() })
    const reader = readEvents<number>(async () => new Response(body), false)
    const received: number[] = []

    reader.on(value => received.push(value))
    reader.start()
    await until(() => reader.status() === 'done')

    expect(received).toEqual([1])
  })

  it('closes a socket with the component that opened it', () => {
    let room: { status: () => string } | undefined

    root((dispose) => {
      room = socket(chat, '/:room', { params: { room: 'general' } })
      dispose()
    })

    expect(room!.status()).toBe('closed')
  })

  it('reconnects a GET stream that dropped before its end', async () => {
    const retries = retriesByHand()
    const bodies = ['data: [1]\n\n', 'data: [2]\n\nevent: end\ndata:\n\n']
    const reader = readEvents<number>(async () => new Response(bodies.shift()), true)
    const received: number[] = []

    reader.on(value => received.push(value))
    reader.start()

    try {
      await retries.until(() => reader.status() === 'done')
    }
    finally {
      retries.restore()
    }

    expect(received).toEqual([1, 2])
  })

  it('keeps one abort listener for a stream however many times it reconnects', async () => {
    const bodies = ['data: [1]\n\n', 'data: [2]\n\n', 'data: [3]\n\nevent: end\ndata:\n\n']
    let listening = 0
    const reader = readEvents<number>(async (signal) => {
      if (listening === 0) {
        const add = signal.addEventListener.bind(signal)
        const remove = signal.removeEventListener.bind(signal)

        signal.addEventListener = ((...args: Parameters<typeof add>) => {
          listening++
          add(...args)
        }) as typeof add
        signal.removeEventListener = ((...args: Parameters<typeof remove>) => {
          listening--
          remove(...args)
        }) as typeof remove
      }

      return new Response(bodies.shift())
    }, true)

    reader.start()
    await until(() => reader.status() === 'done')

    expect(listening).toBe(0)
  })

  it('sends the last 100 messages queued while connecting, and none once closed', () => {
    const sent: string[] = []
    const ws = Object.assign(new EventTarget(), { readyState: 0, send: (text: string) => sent.push(text), close: () => undefined }) as unknown as WebSocket
    const room = openSocket<number, never>(() => ws)

    room.start()

    for (let n = 0; n < 150; n++)
      room.send(n)

    ws.dispatchEvent(new Event('open'))

    expect([sent.length, sent[0], sent.at(-1)]).toEqual([100, '50', '149'])

    sent.length = 0
    room.close()
    room.send(1)
    ws.dispatchEvent(new Event('open'))

    expect(sent).toEqual([])
  })

  it('holds the reconnect of a dropped stream while the tab is hidden, and makes it once the tab shows', async () => {
    const tab = Object.assign(new EventTarget(), { hidden: true })
    const globals = globalThis as Record<string, unknown>
    const listening = listenerCount(globalThis, tab)
    const retries = retriesByHand()

    globals.document = tab

    try {
      const bodies = ['data: [1]\n\n', 'data: [2]\n\nevent: end\ndata:\n\n']
      const reader = readEvents<number>(async () => new Response(bodies.shift()), true)
      const received: number[] = []

      reader.on(value => received.push(value))
      reader.start()
      await retries.until(() => listening.count() === 2)

      expect(received).toEqual([1])
      expect(reader.status()).toBe('connecting')

      tab.hidden = false
      tab.dispatchEvent(new Event('visibilitychange'))
      await retries.until(() => reader.status() === 'done')

      expect(received).toEqual([1, 2])
    }
    finally {
      retries.restore()
      listening.restore()
      delete globals.document
    }
  })

  it('holds the reconnect while offline until the browser is online, and drops it and its listeners once closed', async () => {
    const tab = Object.assign(new EventTarget(), { hidden: false })
    const globals = globalThis as Record<string, unknown>
    const network = (onLine: boolean) => Object.defineProperty(navigator, 'onLine', { value: onLine, configurable: true })
    const listening = listenerCount(globalThis, tab)
    const retries = retriesByHand()

    globals.document = tab
    network(false)

    try {
      let calls = 0
      const reader = readEvents<number>(async () => {
        calls++

        return new Response('data: [1]\n\n')
      }, true)

      reader.start()
      await retries.until(() => listening.count() === 2)
      expect([calls, listening.count()]).toEqual([1, 2])

      network(true)
      globalThis.dispatchEvent(new Event('online'))
      await retries.until(() => calls === 2)
      expect(listening.count()).toBe(0)

      network(false)
      await retries.until(() => listening.count() === 2)
      reader.close()
      expect(listening.count()).toBe(0)
      network(true)
      globalThis.dispatchEvent(new Event('online'))
      tab.dispatchEvent(new Event('visibilitychange'))
      await turns()
      expect(calls).toBe(2)
    }
    finally {
      retries.restore()
      listening.restore()
      delete globals.document
      delete (navigator as { onLine?: boolean }).onLine
    }
  })

  it('tries now and then while the browser says it is offline, as long as the tab shows', async () => {
    const tab = Object.assign(new EventTarget(), { hidden: false })
    const globals = globalThis as Record<string, unknown>
    const later = setTimeout
    // The minute-long fallbacks, run by hand rather than waited for.
    const fallbacks: (() => void)[] = []
    const timeouts = spyOn(globalThis, 'setTimeout').mockImplementation(((run: () => void, delay?: number) => {
      if (delay !== 60_000)
        return later(run, 0)

      fallbacks.push(run)

      return later(() => undefined, 3_600_000)
    }) as typeof setTimeout)

    const listening = listenerCount(globalThis, tab)

    globals.document = tab
    Object.defineProperty(navigator, 'onLine', { value: false, configurable: true })

    try {
      let calls = 0
      const reader = readEvents<number>(async () => {
        calls++

        return new Response('data: [1]\n\n')
      }, true)

      reader.start()
      await until(() => fallbacks.length === 1)
      expect(calls).toBe(1)

      // Hidden, it waits for the tab to show rather than trying, then tries again a minute after.
      tab.hidden = true
      fallbacks.shift()!()
      await until(() => calls === 2 && listening.count() === 2)
      expect([calls, fallbacks.length]).toEqual([2, 0])

      tab.hidden = false
      tab.dispatchEvent(new Event('visibilitychange'))
      expect([calls, fallbacks.length]).toEqual([2, 1])
      reader.close()
    }
    finally {
      listening.restore()
      timeouts.mockRestore()
      delete globals.document
      delete (navigator as { onLine?: boolean }).onLine
    }
  })

  it('gives an island a module\'s mount in the browser build, none of its server code', async () => {
    const outdir = await mkdtemp(join(tmpdir(), 'kay-live-'))

    try {
      const build = await Bun.build({ entrypoints: [join(fixture, 'src/components/chat.kay')], outdir, target: 'browser', plugins: [apiStubs([{ dir: apiDir, prefix: '' }]), kay()] })
      const code = await build.outputs[0]!.text()

      expect(build.success).toBe(true)
      expect(code).toContain('"/api/chat"')
      expect(code).not.toContain('elysia')

      const shared = await Bun.build({ entrypoints: [join(fixture, 'src/lib/notes.ts')], outdir, target: 'browser', plugins: [apiStubs([{ dir: apiDir, prefix: '' }]), kay()] })

      expect(shared.success).toBe(true)
      expect(await shared.outputs[0]!.text()).toContain('"/api/notes"')
    }
    finally {
      await rm(outdir, { recursive: true, force: true })
    }
  })
})

describe('stream() started from a handler', () => {
  let served: ReturnType<typeof spyOn<typeof globalThis, 'fetch'>>

  // A fetch the site answers, cancelling the answer's body once the signal aborts, as a browser does.
  beforeAll(() => {
    served = spyOn(globalThis, 'fetch').mockImplementation((async (input: RequestInfo | URL, init?: RequestInit) => site.fetch(String(input), init as never)) as typeof fetch)
  })

  afterAll(() => served.mockRestore())

  const stopped = async () => Number(await (await site.fetch('/api/chat/forever/stopped')).text())
  // The route's source stops a while after its run ends, longer under load: how many stopped once `count` did, or after 5 seconds.
  const stopsReach = async (count: number) => {
    for (let waited = 0; await stopped() < count && waited < 5_000; waited += 10)
      await Bun.sleep(10)

    return stopped()
  }

  it('waits idle for start(), each start opening a run with the options given then and forgetting the last', async () => {
    const ticks = root(() => stream(chat, '/ticks', { start: false }))

    expect(ticks.status()).toBe('idle')
    expect(served).not.toHaveBeenCalled()

    ticks.start({ query: { count: 2 } })
    await until(() => ticks.status() === 'done')
    expect(ticks.last()?.tick).toBe(2)
    expect(String(served.mock.calls.at(-1)?.[0])).toBe('/api/chat/ticks?count=2')

    ticks.start({ query: { count: 1 } })
    expect(ticks.status()).toBe('connecting')
    expect(ticks.last()).toBeUndefined()
    await until(() => ticks.status() === 'done')
    expect(ticks.last()?.at).toEqual(new Date(Date.UTC(2026, 0, 1)))
  })

  it('stops the route\'s source when closed, and starts again after', async () => {
    const forever = root(() => stream(chat, '/forever', { start: false }))
    const before = await stopped()

    forever.start()
    await until(() => (forever.last() ?? 0) >= 2)
    forever.close()
    expect(forever.status()).toBe('closed')
    expect(await stopsReach(before + 1)).toBe(before + 1)

    forever.start()
    await until(() => (forever.last() ?? 0) >= 1)
    expect(forever.status()).toBe('open')
    forever.start()
    expect(await stopsReach(before + 2)).toBe(before + 2)
    forever.close()
    // Its stop landing later would count for the next test.
    expect(await stopsReach(before + 3)).toBe(before + 3)
  }, 20_000)

  it('stops the route\'s source once the island goes', async () => {
    const before = await stopped()

    // An island's browser, where the stream starts once mounted.
    globalThis.document = { querySelector: () => null } as unknown as Document

    try {
      const [forever, dispose] = root(dispose => [stream(chat, '/forever'), dispose] as const)

      await until(() => (forever.last() ?? 0) >= 1)
      dispose()
      expect(forever.status()).toBe('closed')
      expect(await stopsReach(before + 1)).toBe(before + 1)
    }
    finally {
      Reflect.deleteProperty(globalThis, 'document')
    }
  }, 15_000)

  it('delivers nothing more of a run once a listener starts another, events left in its chunk included', async () => {
    const answer = (values: number[]) => async () => new Response(values.map(value => `data: ${encodeValue(value)}\n\n`).join(''))
    const reader = readEvents<number>(answer([1, 2, 3]), false, true)
    const seen: number[] = []

    reader.on((value) => {
      seen.push(value)

      if (value === 1)
        reader.start(answer([10]))
    })
    reader.start()
    await until(() => seen.includes(10))
    await Bun.sleep(10)
    expect(seen).toEqual([1, 10])
  })

  it('posts a body carrying a file, or a FormData, as a form', async () => {
    const lines = root(() => stream(chat, '/lines', { method: 'post', start: false }))
    const values: string[] = []

    lines.on(line => void values.push(line))
    lines.start({ body: { file: new File(['a\nb'], 'lines.txt'), prefix: '> ' } })
    await until(() => lines.status() === 'done')
    expect(values).toEqual(['> a', '> b'])
    expect(served.mock.calls.at(-1)?.[1]?.body).toBeInstanceOf(FormData)

    const form = new FormData()

    form.append('file', new File(['c'], 'lines.txt'))
    form.append('prefix', '')
    lines.start({ body: form })
    await until(() => lines.status() === 'done')
    expect(values.at(-1)).toBe('c')
  })

  it('types the options of each start by the route', () => {
    const typed = () => {
      const ticks = stream(chat, '/ticks', { start: false })
      const lines = stream(chat, '/lines', { method: 'post', start: false })

      // @ts-expect-error: the route takes a count
      ticks.start()
      // @ts-expect-error: the count is a number
      ticks.start({ query: { count: '2' } })
      // @ts-expect-error: the route takes a file
      lines.start({ body: { prefix: '' } })
      // @ts-expect-error: /lines answers no GET
      stream(chat, '/lines', { start: false })
      // @ts-expect-error: /answer answers no GET
      stream(chat, '/answer', { body: { prompt: '' } })
      lines.start({ body: new FormData() })

      const tick: number | undefined = ticks.last()?.tick

      return tick
    }

    expect(typed).toBeFunction()
  })
})

describe('resource()', () => {
  let served: ReturnType<typeof spyOn<typeof globalThis, 'fetch'>>

  // An island's browser, as far as resource() reads it: a page with no mount point, and a fetch the site answers.
  beforeAll(() => {
    globalThis.document = { querySelector: () => null } as unknown as Document
    served = spyOn(globalThis, 'fetch').mockImplementation((async (input: RequestInfo | URL, init?: RequestInit) => site.fetch(String(input), init as never)) as typeof fetch)
  })

  afterAll(() => {
    served.mockRestore()
    Reflect.deleteProperty(globalThis, 'document')
  })

  it('reads a GET route as JSON, its dates as their ISO text', async () => {
    const rooms = root(() => resource(chat, '/rooms'))

    expect(rooms.status()).toBe('loading')
    await until(() => rooms.status() !== 'loading')

    expect(rooms.status()).toBe('ready')
    expect(rooms.value()?.map(room => room.name)).toEqual(['general', 'games', 'news'])
    expect(rooms.value()?.[0]?.opened).toBe('2026-01-01T00:00:00.000Z')
    expect(served.mock.calls[0]?.[1]?.headers).toEqual({ accept: 'application/json' })
  })

  it('asks again when a signal its options read changes, keeping the last value meanwhile', async () => {
    const prefix = signal('g')
    const rooms = root(() => resource(chat, '/rooms', () => ({ query: { prefix: prefix() } })))

    await until(() => rooms.status() === 'ready')
    expect(rooms.value()?.map(room => room.name)).toEqual(['general', 'games'])

    prefix.set('n')
    flush()
    expect(rooms.status()).toBe('loading')
    expect(rooms.value()?.map(room => room.name)).toEqual(['general', 'games'])

    await until(() => rooms.status() === 'ready')
    expect(rooms.value()?.map(room => room.name)).toEqual(['news'])
  })

  it('drops an answer a newer request overtook', async () => {
    const older = Promise.withResolvers<Response>()
    const prefix = signal('g')

    served.mockImplementationOnce((async () => older.promise) as unknown as typeof fetch)
    const rooms = root(() => resource(chat, '/rooms', () => ({ query: { prefix: prefix() } })))

    flush()
    prefix.set('n')
    flush()
    await until(() => rooms.status() === 'ready')
    older.resolve(await site.fetch('/api/chat/rooms?prefix=g'))
    await Bun.sleep(20)

    expect(rooms.value()?.map(room => room.name)).toEqual(['news'])
    expect(rooms.status()).toBe('ready')
  })

  it('fails with the status and text a route refused with, and reads it again on refresh', async () => {
    const missing = root(() => resource(chat, '/rooms/:name', { params: { name: 'nowhere' } }))

    await until(() => missing.status() !== 'loading')
    expect(missing.status()).toBe('failed')
    expect(missing.error()).toEqual({ status: 404, message: 'No such room' })

    missing.refresh()
    expect(missing.status()).toBe('loading')
    await until(() => missing.status() !== 'loading')
    expect(missing.error()?.status).toBe(404)
  })

  it('fails with status 0 when no answer came', async () => {
    served.mockImplementationOnce((async () => Promise.reject(new TypeError('offline'))) as unknown as typeof fetch)
    const rooms = root(() => resource(chat, '/rooms'))

    await until(() => rooms.status() !== 'loading')
    expect(rooms.error()).toEqual({ status: 0, message: 'offline' })
  })

  it('aborts what it asked once its component is gone', () => {
    const [rooms, dispose] = root(done => [resource(chat, '/rooms'), done] as const)

    flush()
    dispose()

    const calls = served.mock.calls.length

    expect((served.mock.calls.at(-1)?.[1]?.signal as AbortSignal).aborted).toBe(true)
    expect(rooms.status()).toBe('loading')

    rooms.refresh()
    expect(served.mock.calls.length).toBe(calls)
  })

  it('reads any async function, reactively, and drops an answer a newer run overtook', async () => {
    const query = signal('a')
    const gates = new Map<string, PromiseWithResolvers<string>>()
    const seen: AbortSignal[] = []
    const found = root(() => resource(async (abort) => {
      const wanted = query()
      const gate = Promise.withResolvers<string>()

      gates.set(wanted, gate)
      seen.push(abort)

      return gate.promise
    }))

    flush()
    query.set('b')
    flush()
    expect(seen[0]?.aborted).toBe(true)
    gates.get('b')?.resolve('B')
    await until(() => found.status() === 'ready')
    gates.get('a')?.resolve('A')
    await Bun.sleep(10)

    expect(found.value()).toBe('B')
    expect(found.status()).toBe('ready')
  })

  it('fails a function with status 0 and its message, and runs it again on refresh', async () => {
    let runs = 0
    const found = root(() => resource(() => {
      runs++

      if (runs === 1)
        throw new Error('down')

      return 'up'
    }))

    await until(() => found.status() !== 'loading')
    expect(found.status()).toBe('failed')
    expect(found.error()).toEqual({ status: 0, message: 'down' })

    found.refresh()
    await until(() => found.status() === 'ready')

    expect(found.value()).toBe('up')
    expect(found.error()).toBeUndefined()
  })

  it('aborts a function once its component is gone, and keeps the status of an ApiError it throws', async () => {
    let seen: AbortSignal | undefined
    const [found, dispose] = root(done => [resource(async (abort) => {
      seen = abort

      throw new ApiError(503, 'busy')
    }), done] as const)

    await until(() => found.status() === 'failed')
    expect(found.error()).toEqual({ status: 503, message: 'busy' })

    const typed: Promise<number | undefined> = Promise.resolve(root(() => resource(async () => 1)).value())

    await typed
    dispose()
    expect(seen?.aborted).toBe(true)
  })

  it('takes only the GET routes answering a value, with the params they name', () => {
    const typed = () => {
      // @ts-expect-error: an event stream is read with stream()
      resource(chat, '/ticks', { query: { count: 1 } })
      // @ts-expect-error: the room's name is a param the path names
      resource(chat, '/rooms/:name')
      // @ts-expect-error: a number crosses as bare text, typed nowhere
      resource(chat, '/count')
      // @ts-expect-error: a value from JSON has no Date
      resource(chat, '/rooms').value()?.[0]?.opened.getTime() // eslint-disable-line ts/no-unsafe-call -- the line is a type test: it must fail to type, which leaves the call unresolved
    }

    expect(typed).toBeFunction()
  })
})

describe('call()', () => {
  let served: ReturnType<typeof spyOn<typeof globalThis, 'fetch'>>

  // A fetch the site answers, rejecting with the signal's reason once it aborts, as fetch does.
  beforeAll(() => {
    served = spyOn(globalThis, 'fetch').mockImplementation((async (input: RequestInfo | URL, init?: RequestInit) => {
      init?.signal?.throwIfAborted()

      return Promise.race([site.fetch(String(input), init as never), new Promise<never>((_, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal!.reason)))])
    }) as typeof fetch)
  })

  afterAll(() => served.mockRestore())

  it('calls any method of a route, sending its body as JSON and reading its answer typed', async () => {
    const added = await call(notes, '/', { method: 'post', body: { title: 'Milk' } })

    expect(added).toEqual({ id: added.id, title: 'Milk', at: '2026-01-01T00:00:00.000Z' })
    expect(served.mock.calls.at(-1)?.[1]).toMatchObject({ method: 'POST', headers: { 'accept': 'application/json', 'content-type': 'application/json' }, body: '{"title":"Milk"}' })
    expect(await call(notes, '/:id', { method: 'patch', params: { id: added.id }, body: { title: 'Oat milk' } })).toMatchObject({ title: 'Oat milk' })
    expect((await call(notes, '/')).map(note => note.title)).toContain('Oat milk')
    expect(await call(notes, '/:id', { method: 'delete', params: { id: added.id } })).toBe('true')
  })

  it('throws an ApiError with the status and message of a refusal, and status 0 when no answer came', async () => {
    const missing = call(notes, '/:id', { method: 'patch', params: { id: 404 }, body: { title: 'x' } })

    await expect(missing).rejects.toBeInstanceOf(ApiError)
    await expect(missing).rejects.toMatchObject({ status: 404, message: 'No such note', answer: 'No such note' })
    await expect(call(notes, '/', { method: 'post', body: { title: '' } })).rejects.toMatchObject({ status: 422 })

    served.mockImplementationOnce((async () => Promise.reject(new TypeError('Failed to fetch'))) as unknown as typeof fetch)
    await expect(call(notes, '/')).rejects.toMatchObject({ name: 'ApiError', status: 0, message: 'Failed to fetch' })
  })

  it('aborts a call with its signal, which rejects with the signal\'s reason', async () => {
    const controller = new AbortController()
    const slow = call(notes, '/slow', { signal: controller.signal })

    controller.abort()
    await expect(slow).rejects.toMatchObject({ name: 'AbortError' })
    await expect(call(notes, '/slow', { signal: AbortSignal.abort(new Error('gone')) })).rejects.toThrow('gone')
  })

  it('sends a body carrying a file as a form, and reports its upload where the browser can', async () => {
    const file = new File(['hello'], 'hello.txt', { type: 'text/plain' })

    expect(await call(notes, '/attachments', { method: 'post', body: { file, caption: 'Hi' } })).toEqual({ name: 'hello.txt', size: 5, caption: 'Hi' })
    expect(served.mock.calls.at(-1)?.[1]?.body).toBeInstanceOf(FormData)

    const form = new FormData()
    const sent: number[] = []

    form.append('file', file)
    form.append('caption', 'Form')
    globalThis.XMLHttpRequest = UploadRequest as unknown as typeof XMLHttpRequest

    try {
      expect(await call(notes, '/attachments', { method: 'post', body: form, progress: fraction => void sent.push(fraction) })).toEqual({ name: 'hello.txt', size: 5, caption: 'Form' })
      expect(sent).toEqual([0.5, 1])

      const controller = new AbortController()
      const aborted = call(notes, '/attachments', { method: 'post', body: form, progress: () => undefined, signal: controller.signal })

      controller.abort(new Error('cancelled'))
      await expect(aborted).rejects.toThrow('cancelled')
    }
    finally {
      Reflect.deleteProperty(globalThis, 'XMLHttpRequest')
    }
  })

  it('throws an ApiError with status 0 for an answer cut off, and the status for a refusal whose JSON does not parse or that is empty', async () => {
    const answer = (body: BodyInit | null, init: ResponseInit) => served.mockImplementationOnce((async () => new Response(body, init)) as unknown as typeof fetch)
    const cut = new ReadableStream<Uint8Array>({
      start: (controller) => {
        controller.enqueue(new TextEncoder().encode('[1,'))
        controller.error(new TypeError('ECONNRESET'))
      },
    })

    answer(cut, { headers: { 'content-type': 'application/json' } })
    await expect(call(notes, '/')).rejects.toMatchObject({ name: 'ApiError', status: 0, message: 'ECONNRESET' })
    answer('{oops', { status: 500, headers: { 'content-type': 'application/json' } })
    await expect(call(notes, '/')).rejects.toMatchObject({ name: 'ApiError', status: 500, message: '{oops', answer: '{oops' })
    answer('<p>Down</p>', { status: 502, headers: { 'content-type': 'text/html' } })
    await expect(call(notes, '/')).rejects.toMatchObject({ status: 502, message: '<p>Down</p>' })
    answer(null, { status: 503 })
    await expect(call(notes, '/')).rejects.toMatchObject({ status: 503, message: 'HTTP 503' })
    answer('', { headers: { 'content-type': 'application/json' } })
    expect(await call(notes, '/') as unknown).toBe('')
  })

  it('rejects with the signal\'s reason when aborted while the answer is read', async () => {
    const controller = new AbortController()

    served.mockImplementationOnce((async () => new Response(new ReadableStream({
      start: (body) => {
        body.enqueue(new TextEncoder().encode('[1,'))
        controller.signal.addEventListener('abort', () => body.error(controller.signal.reason))
      },
    }), { headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch)

    const reading = call(notes, '/', { signal: controller.signal })

    await Bun.sleep(5)
    controller.abort(new Error('left'))
    await expect(reading).rejects.toThrow('left')
    await expect(reading).rejects.not.toBeInstanceOf(ApiError)
  })

  it('reads a file as a Blob, nothing as \'\', and reaches a path named like a method', async () => {
    const bytes: Blob | string = await call(notes, '/bytes')
    const touched: '' = await call(notes, '/touch', { method: 'post' })

    expect(bytes).toBeInstanceOf(Blob)
    expect([...await (bytes as Blob).bytes()]).toEqual([0, 255])
    expect(touched).toBe('')
    expect(await call(notes, '/post/:id', { params: { id: '7' } })).toBe('post 7')
  })

  it('sends a Date as its ISO text and an object as JSON, in a query or a form, leaving null out', async () => {
    const at = new Date(Date.UTC(2026, 0, 2))

    await call(notes, '/', { query: { since: at, filter: { done: false }, none: null } })
    expect(String(served.mock.calls.at(-1)?.[0])).toBe(`/api/notes?since=${encodeURIComponent(at.toISOString())}&filter=${encodeURIComponent('{"done":false}')}`)

    await Promise.allSettled([call(notes, '/attachments', { method: 'post', body: { file: new File(['a'], 'a.txt'), caption: 'Hi', at, none: null } as never })])
    const form = served.mock.calls.at(-1)?.[1]?.body as FormData

    expect(form.get('at')).toBe(at.toISOString())
    expect(form.has('none')).toBe(false)
  })

  it('works from a module several islands share, as from an island', async () => {
    expect(await addNote('Bread')).toBeNumber()
  })

  it('takes the methods, params and body each route declares', () => {
    const typed = async () => {
      // @ts-expect-error: a websocket route is opened with socket()
      void call(chat, '/:room', { params: { room: 'a' } })
      // @ts-expect-error: the note's id is a param the path names
      void call(notes, '/:id', { method: 'delete' })
      // @ts-expect-error: the route takes a title
      void call(notes, '/', { method: 'post', body: {} })
      // @ts-expect-error: the path answers no GET, so the method is named
      void call(notes, '/attachments', { body: { file: new File([], 'a'), caption: '' } })
      // @ts-expect-error: a value from JSON has no Date
      void (await call(notes, '/'))[0]?.at.getTime() // eslint-disable-line ts/no-unsafe-call -- the line is a type test: it must fail to type, which leaves the call unresolved
    }

    expect(typed).toBeFunction()
  })
})

// An XMLHttpRequest as far as a call reads it: the site answers, and the upload goes in two halves.
class UploadRequest {
  readonly upload: { onprogress: ((event: { lengthComputable: boolean, loaded: number, total: number }) => void) | null } = { onprogress: null }
  responseType = ''
  status = 0
  response: Blob | null = null
  onload: (() => void) | null = null
  onerror: (() => void) | null = null
  ontimeout: (() => void) | null = null
  onabort: (() => void) | null = null
  private method = ''
  private url = ''
  private readonly headers: Record<string, string> = {}
  private answered = ''
  private aborted = false

  open(method: string, url: string) {
    this.method = method
    this.url = url
  }

  setRequestHeader(name: string, value: string) {
    this.headers[name] = value
  }

  getAllResponseHeaders(): string {
    return this.answered
  }

  abort() {
    this.aborted = true
    this.onabort?.()
  }

  send(body: FormData) {
    void this.answer(body)
  }

  private async answer(body: FormData) {
    await Bun.sleep(1)

    if (this.aborted)
      return

    this.upload.onprogress?.({ lengthComputable: true, loaded: 1, total: 2 })
    this.upload.onprogress?.({ lengthComputable: true, loaded: 2, total: 2 })

    const response = await site.fetch(this.url, { method: this.method, headers: this.headers, body })

    this.status = response.status
    this.response = await response.blob()
    this.answered = [...response.headers].map(([name, value]) => `${name}: ${value}`).join('\r\n')
    this.onload?.()
  }
}

describe('kay check, API modules', () => {
  it('types an island\'s sockets and streams from the modules it imports', async () => {
    expect(await check(fixture)).toEqual([])
  }, 60_000)

  it('checks links and redirects against the GET routes of the modules, under their mounts', async () => {
    const scratch = join(import.meta.dir, '../node_modules/.cache')

    await mkdir(scratch, { recursive: true })

    const project = await mkdtemp(join(scratch, 'check-api-'))
    const files = {
      'tsconfig.json': JSON.stringify({ compilerOptions: { target: 'ESNext', jsx: 'preserve', jsxImportSource: 'kay', lib: ['ESNext', 'DOM'], rootDirs: ['.', '.kay/types'], module: 'Preserve', moduleResolution: 'bundler', strict: true, noEmit: true, skipLibCheck: true }, include: ['src', '.kay/types'] }),
      'src/api/index.ts': 'import { Elysia } from \'elysia\'\n\nexport default new Elysia().get(\'/\', () => \'ok\')\n',
      'src/api/files.ts': 'import { Elysia } from \'elysia\'\n\nexport default new Elysia().get(\'/:name\', () => \'file\').ws(\'/live\', { message() {} })\n',
      'src/routes/index.kay': '--- server\nif (ctx.url.search)\n  ctx.redirect(\'/api/files/moved\')\n---\na(href="/api") a\na(href="/api/files/report.pdf") b\na(href="/api/files") c\na(href="/api/nope/deeper") d\n',
    }

    await Promise.all(Object.entries(files).map(async ([path, content]) => Bun.write(join(project, path), content)))

    try {
      expect((await check(project)).map(d => [d.line, d.message.match(/serves ([^\s;"`]+)/)?.[1]])).toEqual([[7, '/api/files'], [8, '/api/nope/deeper']])
    }
    finally {
      await rm(project, { recursive: true, force: true })
    }
  }, 60_000)
})

describe('rooms', () => {
  const guest = (name: string) => site.socket(party, '/', { query: { name } })
  const members = async (room: string) => (await site.fetch(`/api/party/members/${room}`)).json() as Promise<string[]>

  it('lists who joined a room, sends a message to everyone in it but who it came from, and drops the room once empty', async () => {
    const ada = guest('ada')
    const bob = guest('bob')

    ada.send({ type: 'join', room: 'tea' })
    expect(await ada.next()).toEqual({ type: 'joined', room: 'tea', members: ['ada'] })
    bob.send({ type: 'join', room: 'tea' })
    expect(await bob.next()).toEqual({ type: 'joined', room: 'tea', members: ['ada', 'bob'] })
    expect(await ada.next()).toEqual({ type: 'joined', room: 'tea', members: ['ada', 'bob'] })

    bob.send({ type: 'say', room: 'tea', text: 'hello' })
    expect(await ada.next()).toEqual({ type: 'said', from: 'bob', text: 'hello' })

    ada.send({ type: 'leave', room: 'tea' })
    await until(async () => (await members('tea')).join() === 'bob')
    bob.close()
    await until(async () => (await members('tea')).length === 0)
    expect(bob.received).toEqual([{ type: 'joined', room: 'tea', members: ['ada', 'bob'] }])
    ada.close()
  })

  it('sends a burst of changes as one snapshot, read when it goes', async () => {
    const ada = guest('ada')

    ada.send({ type: 'join', room: 'game' })
    await ada.next()

    for (let bump = 0; bump < 5; bump++)
      ada.send({ type: 'bump', room: 'game' })

    expect(await ada.next()).toEqual({ type: 'score', room: 'game', score: 5 })
    await Bun.sleep(60)
    expect(ada.received).toHaveLength(2)
    ada.close()
  })

  it('joins its rooms again once a dropped connection is back', async () => {
    const ada = guest('ada')

    ada.onOpen(() => ada.send({ type: 'join', room: 'back' }))
    expect(await ada.next()).toEqual({ type: 'joined', room: 'back', members: ['ada'] })

    ada.send({ type: 'drop' })
    expect(await ada.next()).toEqual({ type: 'joined', room: 'back', members: ['ada'] })
    expect(await members('back')).toEqual(['ada'])
    ada.close()
  })

  it('runs the handlers a reconnect calls before what was queued while it was down', async () => {
    const bob = guest('bob')

    bob.send({ type: 'join', room: 'order' })
    await bob.next()

    const ada = guest('ada')

    ada.onOpen(() => ada.send({ type: 'join', room: 'order' }))
    ada.send({ type: 'say', room: 'order', text: 'queued' })

    expect(await bob.next()).toEqual({ type: 'joined', room: 'order', members: ['bob', 'ada'] })
    expect(await bob.next()).toEqual({ type: 'said', from: 'ada', text: 'queued' })
    ada.close()
    bob.close()
  })

  describe('in a SQLite file', () => {
    let dir: string

    const connection = () => {
      const received: string[] = []

      return { received, raw: { sendText: (text: string) => void received.push(text) } }
    }

    beforeAll(async () => {
      dir = await mkdtemp(join(tmpdir(), 'kay-rooms-'))
    })

    afterAll(async () => {
      await rm(dir, { recursive: true, force: true })
    })

    // Two stores on one file stand for two processes.
    function processes(name: string) {
      const stores = [sqliteRooms(join(dir, `${name}.sqlite`), { poll: 5 }), sqliteRooms(join(dir, `${name}.sqlite`), { poll: 5 })] as const

      return { stores, first: rooms<{ text: string }, string>({ store: stores[0] }), second: rooms<{ text: string }, string>({ store: stores[1] }), close: () => {
        for (const store of stores) {
          store.close()
        }
      } }
    }

    it('reads coalesce\'s wait and sqliteRooms\'s poll as durations, or as milliseconds when bare', async () => {
      const bare = rooms<{ text: string }>({ store: sqliteRooms(join(dir, 'durations.sqlite'), { poll: '5ms' }) })
      const room = rooms<{ text: string }>()
      const ada = connection()
      let reads = 0
      const send = room.coalesce(() => ({ text: String(++reads) }), { wait: '20ms' })
      const legacy = room.coalesce(() => ({ text: 'legacy' }), { wait: 20 })

      room.join(ada, 'hall')
      send('hall')
      send('hall')
      send('hall')
      legacy('hall')
      await until(() => ada.received.length === 2)
      expect(ada.received).toContain('{"text":"1"}')
      expect(bare.members('hall')).toEqual([])
      expect(() => room.coalesce(() => ({ text: '' }), { wait: 'soon' as never })).toThrow('coalesce` wait is \'soon\'')
      expect(() => sqliteRooms(join(dir, 'bad.sqlite'), { poll: '0ms' })).toThrow('sqliteRooms` poll')
    })

    it('lists the members of every process and reaches them, but the sender or to the member named', async () => {
      const { first, second, close } = processes('reach')
      const [ada, bob, host] = [connection(), connection(), connection()]

      try {
        first.join(ada, 'hall', 'ada')
        second.join(bob, 'hall', 'bob')
        second.join(host, 'hall', 'host')
        expect(first.members('hall')).toEqual(['ada', 'bob', 'host'])
        expect(second.roomsOf(bob)).toEqual(['hall'])

        first.publish('hall', { text: 'hi' })
        await until(() => bob.received.length === 1 && host.received.length === 1)
        expect(ada.received).toEqual(['{"text":"hi"}'])

        second.publish('hall', { text: 'back' }, { except: bob })
        await until(() => ada.received.length === 2)
        expect(bob.received).toEqual(['{"text":"hi"}'])

        first.publish('hall', { text: 'host only' }, { to: 'host' })
        await until(() => host.received.length === 3)
        expect([ada.received.length, bob.received.length]).toEqual([2, 1])

        // Joining again changes the member, in its place.
        second.join(bob, 'hall', 'robert')
        expect(first.members('hall')).toEqual(['ada', 'robert', 'host'])

        second.leave(bob)
        expect(first.members('hall')).toEqual(['ada', 'host'])
        expect(second.roomsOf(bob)).toEqual([])
      }
      finally {
        close()
      }
    })

    it('keeps a member joined as null apart from a connection joined without one, in every process', async () => {
      const { stores, close } = processes('nullable')
      const [first, second] = stores.map(store => rooms<{ text: string }, string | null | undefined>({ store }))
      const [guest, anonymous, ada] = [connection(), connection(), connection()]

      try {
        first!.join(guest, 'hall', null)
        first!.join(anonymous, 'hall')
        second!.join(ada, 'hall', 'ada')
        expect(second!.members('hall')).toEqual([null, undefined, 'ada'])

        second!.publish('hall', { text: 'guests' }, { to: null })
        await until(() => guest.received.length === 1)
        expect([anonymous.received, ada.received]).toEqual([[], []])
      }
      finally {
        close()
      }
    })

    it('sends a process only what is published once it listens, not what came before', async () => {
      const { first, second, close } = processes('fresh')
      const ada = connection()

      try {
        second.publish('hall', { text: 'before' })
        first.join(ada, 'hall', 'ada')
        second.publish('hall', { text: 'after' })
        await until(() => ada.received.length > 0)
        expect(ada.received).toEqual(['{"text":"after"}'])
      }
      finally {
        close()
      }
    })

    it('drops the members of a process no longer heard from, and writes them back once a stalled one runs again', async () => {
      // The heartbeats, run by hand rather than waited for.
      const beats: (() => void)[] = []
      const realInterval = setInterval
      const intervals = spyOn(globalThis, 'setInterval').mockImplementation(((run: () => void, delay?: number) => {
        if (delay !== 2_000)
          return realInterval(run, delay)

        beats.push(run)

        return realInterval(() => undefined, 3_600_000)
      }) as typeof setInterval)
      const { first, second, close } = processes('expiry')

      const [ada, bob] = [connection(), connection()]
      const file = new Database(join(dir, 'expiry.sqlite'))

      try {
        first.join(ada, 'hall', 'ada')
        second.join(bob, 'hall', 'bob')

        // Every process silent for a minute, as a crashed one is, and then the others prune them.
        file.run('UPDATE kay_room_processes SET seen = seen - 60000')
        expect(first.members('hall')).toEqual([])
        file.run('DELETE FROM kay_room_members')
        file.run('DELETE FROM kay_room_processes')

        // The next heartbeat finds each process dropped and writes its members back.
        expect(beats).toHaveLength(2)

        for (const beat of beats)
          beat()

        expect(first.members('hall')).toEqual(['ada', 'bob'])
      }
      finally {
        intervals.mockRestore()
        file.close()
        close()
      }
    })

    it('beats and polls only while a connection of the process is joined, and indexes what the beat deletes by', async () => {
      const timers: number[] = []
      const realInterval = setInterval
      const cleared = spyOn(globalThis, 'clearInterval')
      const intervals = spyOn(globalThis, 'setInterval').mockImplementation(((run: () => void, delay?: number) => {
        timers.push(delay ?? 0)

        return realInterval(run, delay)
      }) as typeof setInterval)
      const path = join(dir, 'idle.sqlite')
      const old = new Database(path)

      // A file from before the indexes: opening it adds them.
      old.run('CREATE TABLE kay_room_members (room TEXT NOT NULL, connection TEXT NOT NULL, process TEXT NOT NULL, member TEXT NOT NULL, PRIMARY KEY (room, connection))')
      old.run('CREATE TABLE kay_room_messages (id INTEGER PRIMARY KEY AUTOINCREMENT, room TEXT NOT NULL, text TEXT NOT NULL, process TEXT NOT NULL, skipped TEXT, recipient TEXT, at INTEGER NOT NULL)')
      old.close()

      const store = sqliteRooms(path, { poll: 5 })
      const room = rooms<{ text: string }, string>({ store })
      const ada = connection()
      const file = new Database(path)
      const processesNow = () => {
        const reader = new Database(path)

        try {
          return reader.query('SELECT process FROM kay_room_processes').all()
        }
        finally {
          reader.close()
        }
      }

      try {
        const plans = (sql: string) => file.query<{ detail: string }, []>(`EXPLAIN QUERY PLAN ${sql}`).all().map(row => row.detail).join(' ')

        expect(plans('DELETE FROM kay_room_messages WHERE at <= 1')).toContain('kay_room_messages_at')
        expect(plans('DELETE FROM kay_room_members WHERE process IN (SELECT process FROM kay_room_processes WHERE seen <= 1)')).toContain('kay_room_members_process')

        // No connection, nothing running and no process listed.
        room.publish('hall', { text: 'alone' })
        expect(timers).toEqual([])
        expect(processesNow()).toEqual([])

        room.join(ada, 'hall', 'ada')
        expect(timers.toSorted((a, b) => a - b)).toEqual([5, 2000])
        expect(processesNow()).toHaveLength(1)

        room.leave(ada)
        expect(cleared).toHaveBeenCalledTimes(2)
        timers.length = 0
        room.join(ada, 'hall', 'ada')
        expect(timers.toSorted((a, b) => a - b)).toEqual([5, 2000])

        // Leaving a listener after the store closed neither beats nor throws.
        const afterClose = sqliteRooms(join(dir, 'closed.sqlite'))
        const stop = afterClose.subscribe(() => undefined)

        afterClose.add('hall', 'c1', '')
        afterClose.close()
        expect(stop).not.toThrow()
      }
      finally {
        intervals.mockRestore()
        cleared.mockRestore()
        file.close()
        store.close()
      }
    })

    it('prunes old messages and silent processes when a process only publishes, at most once per heartbeat', () => {
      const path = join(dir, 'publish-only.sqlite')
      const store = sqliteRooms(path, { poll: 5 })
      const file = new Database(path)
      const count = (table: string) => file.query<{ n: number }, []>(`SELECT count(*) AS n FROM ${table}`).get()!.n
      const old = () => {
        file.run('INSERT INTO kay_room_messages (room, text, process, at) VALUES (\'hall\', \'old\', \'gone\', 1)')
        file.run('INSERT OR REPLACE INTO kay_room_processes (process, seen) VALUES (\'gone\', 1)')
        file.run('INSERT OR REPLACE INTO kay_room_members (room, connection, process, member) VALUES (\'hall\', \'c\', \'gone\', \'\')')
      }

      try {
        old()
        store.publish('hall', 'one', {})
        expect(count('kay_room_messages')).toBe(1)
        expect(count('kay_room_processes')).toBe(0)
        expect(count('kay_room_members')).toBe(0)

        // A second publish within the heartbeat leaves pruning for later.
        old()
        store.publish('hall', 'two', {})
        expect(count('kay_room_messages')).toBe(3)
      }
      finally {
        file.close()
        store.close()
      }
    })

    it('stores and delivers a message even when the prune after it fails', () => {
      const path = join(dir, 'prune-fails.sqlite')
      const store = sqliteRooms(path, { poll: 5 })
      const file = new Database(path)
      const heard: string[] = []
      const logged = spyOn(console, 'error').mockImplementation(() => undefined)

      try {
        store.subscribe((_room, text) => void heard.push(text))
        file.run('DROP TABLE kay_room_processes')
        expect(() => store.publish('hall', 'one', {})).not.toThrow()
        expect(heard).toEqual(['one'])
        expect(file.query<{ n: number }, []>('SELECT count(*) AS n FROM kay_room_messages').get()!.n).toBe(1)
      }
      finally {
        logged.mockRestore()
        file.close()
        store.close()
      }
    })
  })

  it('calls the handler a message\'s type names, and refuses a type none names', () => {
    type Message = { type: 'add', amount: number } | { type: 'reset' }
    const handle = (message: Message) => dispatch(message, { add: ({ amount }) => amount, reset: () => 0 })

    expect(handle({ type: 'add', amount: 3 })).toBe(3)
    expect(handle({ type: 'reset' })).toBe(0)
    expect(() => handle({ type: 'toString' } as never)).toThrow('no handler for a message of type toString')
    const reset = { type: 'reset' } as Message

    // @ts-expect-error every type is handled
    dispatch(reset, { reset: () => 0 })
  })
})

describe('stream() over an async iterable', () => {
  beforeAll(() => {
    globalThis.document = { querySelector: () => null } as unknown as Document
  })

  afterAll(() => {
    Reflect.deleteProperty(globalThis, 'document')
  })

  it('reads each value, then is done', async () => {
    const reader = root(() => stream(async function* () {
      yield 1
      yield 2
    }))
    const heard: number[] = []

    reader.on(value => heard.push(value))
    flush()
    await until(() => reader.status() === 'done')

    expect(reader.last()).toBe(2)
    expect(heard).toEqual([1, 2])
  })

  it('fails when the iterable throws', async () => {
    const reader = root(() => stream(async function* () {
      yield 1

      throw new Error('cut')
    }))

    flush()
    await until(() => reader.status() === 'failed')

    expect(reader.last()).toBe(1)
  })

  it('never starts once closed before it mounts', () => {
    let calls = 0
    const reader = root(() => {
      const read = stream(async function* () {
        calls++
        yield 1
      })

      read.close()

      return read
    })

    flush()
    expect(calls).toBe(0)
    expect(reader.status()).toBe('closed')
  })

  it('aborts the signal and stops reading once closed', async () => {
    let aborted: AbortSignal | undefined
    const reader = root(() => stream(async function* (signal) {
      aborted = signal
      yield 1
      await Bun.sleep(20)
      yield 2
    }))

    flush()
    await until(() => reader.last() === 1)
    reader.close()
    await Bun.sleep(40)

    expect(aborted?.aborted).toBe(true)
    expect(reader.status()).toBe('closed')
    expect(reader.last()).toBe(1)
  })
})

describe('routeUrl', () => {
  const users = { [Symbol.for('kay.api')]: '/api/users' }

  it('refuses a param that is a dot segment, which would reach the parent route', () => {
    for (const id of ['.', '..'])
      expect(() => routeUrl(users, '/:id', { params: { id } })).toThrow(TypeError)
  })

  it('encodes a dot-like param so it stays one segment', () => {
    expect(routeUrl(users, '/:id', { params: { id: '%2e%2e' } })).toBe('/api/users/%252e%252e')
    expect(routeUrl(users, '/:id', { params: { id: 'a/../b' } })).toBe('/api/users/a%2F..%2Fb')
    expect(routeUrl(users, '/:id', { params: { id: '...' } })).toBe('/api/users/...')
  })

  it('encodes each segment of a wildcard and refuses dot segments in it', () => {
    expect(routeUrl(users, '/files/*', { params: { '*': 'a b/c%2Fd/e?f#g' } })).toBe('/api/users/files/a%20b/c%252Fd/e%3Ff%23g')
    expect(routeUrl(users, '/files/*', { params: { '*': '' } })).toBe('/api/users/files/')

    for (const rest of ['..', '.', 'a/../b', 'a/./b', '../b', 'a/..'])
      expect(() => routeUrl(users, '/files/*', { params: { '*': rest } })).toThrow(TypeError)

    expect(routeUrl(users, '/files/*', { params: { '*': '%2e%2e/b' } })).toBe('/api/users/files/%252e%252e/b')
  })

  it('rejects a call whose param is a dot segment before any fetch', async () => {
    await expect(call(users as never, '/:id' as never, { params: { id: '..' } } as never)).rejects.toThrow(TypeError)
  })
})
