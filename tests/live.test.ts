import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it, spyOn } from 'bun:test'
import { kay } from '../src/build/plugin'
import { check } from '../src/check'
import { root } from '../src/runtime'
import { readEvents, socket } from '../src/runtime/live'
import { apiStubs, scanApi } from '../src/server/api'
import { testSite } from '../src/test'

const fixture = join(import.meta.dir, 'fixtures/live')
const apiDir = join(fixture, 'src/api')
// Written for this file only: any other test building the repository's root as one project would bundle the island's server imports, missing the fixture's API directory.
const components = {
  'src/components/chat.kay': '---\nimport { socket, stream } from \'kay\'\nimport chat from \'../api/chat\'\n\nconst { room } = props<{ room: string }>()\nconst messages = socket(chat, \'/:room\', { params: { room } })\nconst ticks = stream(chat, \'/ticks\', { query: { count: 3 } })\n---\nsection\n  p.status {messages.status()}\n  p.last {messages.last()?.text ?? \'Nothing yet\'}\n  p.tick {ticks.last()?.tick ?? 0}\n  button(onClick={() => messages.send({ text: \'hello\' })}) Send\n',
  'src/routes/index.kay': '---\nimport Chat from \'../components/chat.kay\'\n---\nh1 Live\nChat(room="general")\na(href="/api/chat/ticks") Ticks\n',
}

await Promise.all(Object.entries(components).map(async ([path, source]) => Bun.write(join(fixture, path), source)))
const reported: unknown[] = []
const site = await testSite({ routes: 'tests/fixtures/live/src/routes', api: 'tests/fixtures/live/src/api', locals: request => ({ user: request.headers.get('x-user') ?? undefined }), onError: error => void reported.push(error) })
// Imported once the site is up: the modules it mounted, where their routes are served.
const { default: chat } = await import(join(apiDir, 'chat.ts')) as typeof import('./fixtures/live/src/api/chat')
const { default: secret } = await import(join(apiDir, 'private/index.ts')) as typeof import('./fixtures/live/src/api/private/index')

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
    const answer = (headers: Record<string, string>) => site.fetch('/api/chat/answer', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ prompt: 'hi' }) })

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
