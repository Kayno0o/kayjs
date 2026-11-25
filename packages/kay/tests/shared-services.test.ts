import type { ServerAction } from '../src/server/index'
import { afterAll, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAuth, memoryAuthStore } from '../../plugin-auth/src/index'
import { mailer } from '../../plugin-mail/src/index'
import { build } from '../src/build/index'
import { devServer } from '../src/dev/index'
import { createServer } from '../src/server/index'
import { testApp } from '../src/test/index'

const tempDirs: string[] = []
function makeTemp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

const repoRoot = join(import.meta.dir, '../../..')
function linkWorkspace(dir: string): void {
  mkdirSync(join(dir, 'node_modules/@kayjs'), { recursive: true })
  symlinkSync(join(repoRoot, 'packages/kay'), join(dir, 'node_modules/kay'))
  symlinkSync(join(repoRoot, 'packages/kay'), join(dir, 'node_modules/@kayjs/kay'))
  symlinkSync(join(repoRoot, 'packages/plugin-auth'), join(dir, 'node_modules/@kayjs/auth'))
  symlinkSync(join(repoRoot, 'packages/plugin-live'), join(dir, 'node_modules/@kayjs/live'))
  symlinkSync(join(repoRoot, 'packages/plugin-mail'), join(dir, 'node_modules/@kayjs/mail'))
  symlinkSync(join(repoRoot, 'packages/plugin-mcp'), join(dir, 'node_modules/@kayjs/mcp'))
}

afterAll(() => {
  for (const d of tempDirs)
    rmSync(d, { recursive: true, force: true })
})

describe('Shared server module instances & createAuth({ mailer }) (#3552)', () => {
  it('createAuth({ mailer }) delivers magic-link and verification emails without sendMail glue', async () => {
    const dir = makeTemp('kay-auth-mailer-')
    mkdirSync(join(dir, 'src/routes'), { recursive: true })
    writeFileSync(join(dir, 'src/routes/index.tsx'), 'export default function Home() { return <h1>Hi</h1> }\n')

    const mail = mailer({ from: 'App <noreply@example.test>', optional: true })
    const auth = createAuth({
      store: memoryAuthStore(),
      secret: 'test-secret-for-auth-mailer-option-at-least-32-bytes',
      mailer: mail,
    })

    const app = await testApp({
      root: dir,
      site: 'https://app.example.test',
      plugins: [auth.plugin, mail.plugin()],
    })

    const res = await app.post('/auth/magic-link', { email: 'alice@example.test' })
    expect(res.status).toBe(200)
    expect(mail.outbox.length).toBe(1)
    expect(mail.outbox[0]!.to).toEqual(['alice@example.test'])
    expect(mail.outbox[0]!.text).toContain('https://app.example.test/auth/magic-link/verify?token=')

    const preview = await (await app.get('/_kay/mail.json')).json() as { count: number }
    expect(preview.count).toBe(1)
  })

  it('shares a single module instance between kay.config.ts and routes without manual ids (build + start and dev)', async () => {
    const dir = makeTemp('kay-single-instance-')
    linkWorkspace(dir)
    mkdirSync(join(dir, 'src/routes'), { recursive: true })

    writeFileSync(join(dir, 'src/services.ts'), `
      import { createAuth, memoryAuthStore } from '@kayjs/auth'
      import { createRooms } from '@kayjs/live'
      import { mailer } from '@kayjs/mail'

      export const mail = mailer({ from: 'Demo <noreply@demo.local>', optional: true })
      export const auth = createAuth({
        store: memoryAuthStore(),
        secret: 'single-instance-test-secret-at-least-32-bytes',
        requireEmailVerification: false,
        mailer: mail,
      })
      export const rooms = createRooms<{ text: string }, string>()
    `)

    writeFileSync(join(dir, 'kay.config.ts'), `
      import { defineConfig } from 'kay/server'
      import { auth, mail, rooms } from './src/services'

      export default defineConfig({
        site: 'http://localhost',
        plugins: [
          auth.plugin,
          mail.plugin(),
          rooms.plugin({
            path: '/api/events',
            room: 'main',
            member: () => 'guest',
          }),
        ],
      })
    `)

    writeFileSync(join(dir, 'src/routes/index.tsx'), `
      export default function Home() {
        return <h1>Shared Services</h1>
      }
    `)

    writeFileSync(join(dir, 'src/routes/publish.ts'), `
      import type { RequestContext } from 'kay/server'
      import { mail, rooms } from '../services'

      export async function GET(ctx: RequestContext) {
        const size = rooms.size('main')
        rooms.publish('main', { text: 'hello' }, 'msg')
        await mail.send({ to: 'bob@demo.local', subject: 'Ping', text: 'pong' })
        return ctx.json({ size, outbox: mail.outbox.length })
      }
    `)

    // 1. Production build + createServer: single bundled chunk shared by kay.config.js and routes/publish.js
    await build({ root: dir, minify: false })

    const app = await createServer({ root: dir })
    const abort = new AbortController()
    try {
      const sseRes = await app.handle(new Request('http://localhost/api/events', { signal: abort.signal }))
      expect(sseRes.status).toBe(200)
      const reader = sseRes.body!.getReader()
      const first = await reader.read()
      expect(new TextDecoder().decode(first.value)).toContain('retry:')

      // Route sees the exact same `rooms` subscriber opened by kay.config.ts's `rooms.plugin()`
      const pubRes = await app.handle(new Request('http://localhost/publish'))
      const pubJson = await pubRes.json() as { size: number, outbox: number }
      expect(pubJson.size).toBe(1)
      expect(pubJson.outbox).toBe(1)

      const second = await reader.read()
      expect(new TextDecoder().decode(second.value)).toContain('"text":"hello"')

      // `/_kay/mail.json` mounted by `kay.config.ts` sees the exact same `mail.outbox` written by `/publish`
      const mailRes = await app.handle(new Request('http://localhost/_kay/mail.json'))
      const mailJson = await mailRes.json() as { count: number, messages: Array<{ subject: string }> }
      expect(mailJson.count).toBe(1)
      expect(mailJson.messages[0]!.subject).toBe('Ping')
    }
    finally {
      abort.abort()
      await app.dispose?.()
    }

    // 2. Also works in `kay dev` without any manual id
    const dev = await devServer({ root: dir, port: 0 })
    try {
      const pubRes = await fetch(`${dev.url}/publish`)
      expect(pubRes.status).toBe(200)
      const mailRes = await fetch(`${dev.url}/_kay/mail.json`)
      const mailJson = await mailRes.json() as { count: number }
      expect(mailJson.count).toBe(1)
    }
    finally {
      dev.stop()
    }
  })
})

describe('one bundled entry assembles the app (#3577)', () => {
  function writeApp(dir: string, files: Record<string, string>): void {
    linkWorkspace(dir)
    for (const [rel, src] of Object.entries(files)) {
      mkdirSync(join(dir, rel, '..'), { recursive: true })
      writeFileSync(join(dir, rel), src)
    }
  }

  it('runs kay.config.ts on the same module instances as the routes when a test passes plugins', async () => {
    const dir = makeTemp('kay-entry-plugins-')
    writeApp(dir, {
      'src/errors.ts': 'export const errors = { count: 0 }\n',
      'kay.config.ts': `
        import { defineConfig } from 'kay/server'
        import { errors } from './src/errors'
        export default defineConfig({ onError() { errors.count++ } })
      `,
      'src/routes/boom.ts': 'export function GET(): Response { throw new Error(\'boom\') }\n',
      'src/routes/errors.ts': `
        import type { RequestContext } from 'kay/server'
        import { errors } from '../errors'
        export function GET(ctx: RequestContext) { return ctx.text(String(errors.count)) }
      `,
    })

    const app = await testApp({ root: dir, plugins: [] })
    try {
      expect((await app.get('/boom')).status).toBe(500)
      expect(await (await app.get('/errors')).text()).toBe('1')
    }
    finally {
      await app.app.dispose?.()
    }
  })

  it('gives an action imported only by kay.config.ts its url', async () => {
    const dir = makeTemp('kay-entry-config-action-')
    writeApp(dir, {
      'src/ping.ts': `
        import { action } from 'kay/server'
        export const ping = action(async () => 'pong')
      `,
      'kay.config.ts': `
        import { defineConfig } from 'kay/server'
        import { ping } from './src/ping'
        export default defineConfig({
          plugins: [{ name: 'probe', server(api) { api.route('GET', '/ping-url', ctx => ctx.text(ping.url)) } }],
        })
      `,
      'src/routes/index.tsx': 'export default function Home() { return <h1>Home</h1> }\n',
    })

    const app = await testApp({ root: dir })
    try {
      expect(await (await app.get('/ping-url')).text()).toMatch(/^\/_kay\/action\/[\w-]+$/)
    }
    finally {
      await app.app.dispose?.()
    }
  })

  it('runs the _middleware.ts of an action folder when an MCP tool calls it', async () => {
    const dir = makeTemp('kay-entry-mcp-middleware-')
    writeApp(dir, {
      'src/routes/admin/_middleware.ts': `
        import type { Middleware } from 'kay/server'
        const adminsOnly: Middleware = ctx => ctx.deny(403, 'Admins only')
        export default adminsOnly
      `,
      'src/routes/admin/notes.ts': `
        import { action } from 'kay/server'
        export const addNote = action(async () => 'added')
      `,
      'kay.config.ts': `
        import { mcp } from '@kayjs/mcp'
        import { defineConfig } from 'kay/server'
        import { addNote } from './src/routes/admin/notes'
        export default defineConfig({
          plugins: [mcp({ token: 'mcp-key-0123456789', tools: { add: { action: addNote, description: 'Adds a note.' } } })],
        })
      `,
      'src/routes/index.tsx': 'export default function Home() { return <h1>Home</h1> }\n',
    })

    const app = await testApp({ root: dir })
    try {
      const res = await app.fetch('/mcp/tools', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'accept': 'application/json, text/event-stream', 'authorization': 'Bearer mcp-key-0123456789' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'add', arguments: {} } }),
      })
      const json = await res.json() as { result: { content: Array<{ text: string }>, isError?: boolean } }
      expect(json.result.isError).toBe(true)
      expect(json.result.content[0]!.text).toContain('Admins only')
    }
    finally {
      await app.app.dispose?.()
    }
  })

  it('lets a test import a bundled module and submit its action', async () => {
    const dir = makeTemp('kay-entry-import-')
    writeApp(dir, {
      'src/actions/preferences.ts': `
        import { action } from 'kay/server'
        const preferences = { '~standard': { version: 1 as const, vendor: 'test', validate: (value: unknown) => ({ value: value as { theme: string } }) } }
        let theme = 'light'
        export const currentTheme = (): string => theme
        export const savePreferences = action(preferences, async (input) => {
          theme = input.theme
          return theme
        })
      `,
      'src/routes/index.tsx': `
        import { savePreferences } from '../actions/preferences'
        export default function Home() { return <form action={savePreferences}><button>Save</button></form> }
      `,
    })

    const app = await testApp({ root: dir })
    try {
      const prefs = await app.import('src/actions/preferences.ts') as { savePreferences: ServerAction<{ theme: string }, string>, currentTheme: () => string }
      const res = await app.submit(prefs.savePreferences, { theme: 'dark' })

      expect(res.status).toBeLessThan(400)
      expect(prefs.currentTheme()).toBe('dark')
    }
    finally {
      await app.app.dispose?.()
    }
  })
})
