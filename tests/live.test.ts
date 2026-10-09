import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'
import { afterAll, beforeAll, describe, expect, it, spyOn } from 'bun:test'
import { kay } from '../src/build/plugin'
import { check } from '../src/check'
import { flush, root, signal } from '../src/runtime'
import { dispatch, readEvents, resource, socket } from '../src/runtime/live'
import { apiStubs, scanApi } from '../src/server/api'
import { rooms, sqliteRooms } from '../src/server/rooms'
import { testSite } from '../src/test'

const fixture = join(import.meta.dir, 'fixtures/live')
const apiDir = join(fixture, 'src/api')
// Written for this file only: any other test building the repository's root as one project would bundle the island's server imports, missing the fixture's API directory.
const components = {
  'src/components/chat.kay': '---\nimport { resource, socket, stream } from \'kay\'\nimport chat from \'../api/chat\'\n\nconst { room } = props<{ room: string }>()\nconst messages = socket(chat, \'/:room\', { params: { room } })\nconst ticks = stream(chat, \'/ticks\', { query: { count: 3 } })\nconst rooms = resource(chat, \'/rooms\', () => ({ query: { prefix: room.slice(0, 1) } }))\n---\nsection\n  p.status {messages.status()}\n  p.last {messages.last()?.text ?? \'Nothing yet\'}\n  p.tick {ticks.last()?.tick ?? 0}\n  p.rooms {rooms.status()}: {rooms.value()?.map(found => found.name).join(\', \')}\n  button(onClick={() => messages.send({ text: \'hello\' })}) Send\n',
  'src/routes/index.kay': '---\nimport Chat from \'../components/chat.kay\'\n---\nh1 Live\nChat(room="general")\na(href="/api/chat/ticks") Ticks\n',
}

await Promise.all(Object.entries(components).map(async ([path, source]) => Bun.write(join(fixture, path), source)))
const reported: unknown[] = []
const site = await testSite({ routes: 'tests/fixtures/live/src/routes', api: 'tests/fixtures/live/src/api', locals: request => ({ user: request.headers.get('x-user') ?? undefined }), onError: error => void reported.push(error) })
// Imported once the site is up: the modules it mounted, where their routes are served.
const { default: chat } = await import(join(apiDir, 'chat.ts')) as typeof import('./fixtures/live/src/api/chat')
const { default: secret } = await import(join(apiDir, 'private/index.ts')) as typeof import('./fixtures/live/src/api/private/index')
const { default: party } = await import(join(apiDir, 'party.ts')) as typeof import('./fixtures/live/src/api/party')

function upgrade(path: string, headers: Record<string, string> = {}): Request {
  return new Request(`http://localhost${path}`, { headers: { 'upgrade': 'websocket', 'connection': 'Upgrade', 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==', 'sec-websocket-version': '13', ...headers } })
}

afterAll(async () => {
  await site.close()
  await Promise.all(['src/components', 'src/routes'].map(async dir => rm(join(fixture, dir), { recursive: true, force: true })))
})

describe('API modules', () => {
  it('mounts each module under /api by its path, index as its directory, leaving files starting with _ out', async () => {
    expect(await scanApi(apiDir)).toEqual([
      { file: join(apiDir, 'chat.ts'), mount: '/api/chat', guards: [] },
      { file: join(apiDir, 'index.ts'), mount: '/api', guards: [] },
      { file: join(apiDir, 'party.ts'), mount: '/api/party', guards: [] },
      { file: join(apiDir, 'private/index.ts'), mount: '/api/private', guards: [join(apiDir, 'private/_guard.ts')] },
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
    const room = site.socket(chat, '/:room', { params: { room: 'flaky' } })

    room.send({ text: 'drop' })
    await Bun.sleep(50)
    expect(room.status()).toBe('connecting')

    room.send({ text: 'back' })

    expect(await room.next()).toEqual({ room: 'flaky', from: 'anonymous', text: 'back' })
    room.close()
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
    await Bun.sleep(20)

    expect(received).toEqual([1])
    expect(reader.status()).toBe('done')
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
    const bodies = ['data: [1]\n\n', 'data: [2]\n\nevent: end\ndata:\n\n']
    const reader = readEvents<number>(async () => new Response(bodies.shift()), true)
    const received: number[] = []

    reader.on(value => received.push(value))
    reader.start()
    await Bun.sleep(700)

    expect(received).toEqual([1, 2])
    expect(reader.status()).toBe('done')
  })

  it('gives an island a module\'s mount in the browser build, none of its server code', async () => {
    const outdir = await mkdtemp(join(tmpdir(), 'kay-live-'))

    try {
      const build = await Bun.build({ entrypoints: [join(fixture, 'src/components/chat.kay')], outdir, target: 'browser', plugins: [apiStubs(apiDir, await scanApi(apiDir)), kay()] })
      const code = await build.outputs[0]!.text()

      expect(build.success).toBe(true)
      expect(code).toContain('"/api/chat"')
      expect(code).not.toContain('elysia')
    }
    finally {
      await rm(outdir, { recursive: true, force: true })
    }
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

  const until = async (ready: () => boolean) => {
    for (let tries = 0; !ready() && tries < 100; tries++)
      await Bun.sleep(5)
  }

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

describe('kay check, API modules', () => {
  it('types an island\'s sockets and streams from the modules it imports', async () => {
    expect(await check(fixture)).toEqual([])
  })

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
  })
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
    await Bun.sleep(30)
    expect(await members('tea')).toEqual(['bob'])
    bob.close()
    await Bun.sleep(30)
    expect(await members('tea')).toEqual([])
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

    // Polls a condition another process makes true, failing past a second.
    async function until(condition: () => boolean): Promise<void> {
      for (let waited = 0; !condition(); waited += 5) {
        if (waited > 1_000)
          throw new Error('timed out')

        await Bun.sleep(5)
      }
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
        await Bun.sleep(20)
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
        await Bun.sleep(20)
        expect(ada.received).toEqual(['{"text":"after"}'])
      }
      finally {
        close()
      }
    })

    it('drops the members of a process no longer heard from, and writes them back once a stalled one runs again', async () => {
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

        // The next heartbeat, within 2 seconds, finds each process dropped and writes its members back.
        await Bun.sleep(2_200)
        expect(first.members('hall')).toEqual(['ada', 'bob'])
      }
      finally {
        file.close()
        close()
      }
    }, 5_000)
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
