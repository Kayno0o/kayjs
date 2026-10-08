import type { DesktopMessage } from '../src/server/desktop'
import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { describe, expect, it } from 'bun:test'
import { createWebview } from '../src/desktop/webview'

const repo = join(import.meta.dir, '..')

// The server worker of a desktop executable, and the next message it sends.
function startWorker() {
  const worker = new Worker(join(import.meta.dir, 'fixtures/desktop/worker.ts'))
  const next = async () => new Promise<DesktopMessage>((resolve, reject) => {
    worker.addEventListener('message', (event: MessageEvent<DesktopMessage>) => resolve(event.data), { once: true })
    worker.addEventListener('error', event => reject(new Error(event.message)), { once: true })
  })

  return { worker, next }
}

describe('a desktop server', () => {
  it('listens on a free loopback port and answers the window\'s secret alone, until the window closes', async () => {
    const { worker, next } = startWorker()
    const closed = new Promise(resolve => worker.addEventListener('close', resolve))
    const listening = await next()

    if (listening.kind !== 'listening')
      throw new Error(`expected the URL, got ${listening.kind}`)

    const url = new URL(listening.url)
    const origin = url.origin
    const secret = url.searchParams.get('kay-desktop')!

    expect(url.hostname).toBe('127.0.0.1')
    expect(url.port).not.toBe('3000')
    expect(secret.length).toBeGreaterThanOrEqual(43)

    // Nothing answers another program of the machine, the app's own routes and websockets included.
    expect((await fetch(`${origin}/`)).status).toBe(403)
    expect((await fetch(`${origin}/before`)).status).toBe(403)
    expect((await fetch(`${origin}/_kay/health`)).status).toBe(403)
    expect((await fetch(`${origin}/?kay-desktop=${'x'.repeat(secret.length)}`)).status).toBe(403)
    expect((await fetch(`${origin}/`, { headers: { cookie: 'kay-desktop=nope' } })).status).toBe(403)

    // The window's first request trades the secret for a cookie, keeping the rest of the query.
    const first = await fetch(`${origin}/news?page=2&kay-desktop=${secret}`, { redirect: 'manual' })
    const cookie = first.headers.get('set-cookie')!

    expect(first.status).toBe(303)
    expect(first.headers.get('location')).toBe('/news?page=2')
    expect(cookie).toBe(`kay-desktop=${secret}; Path=/; HttpOnly; SameSite=Strict`)

    const headers = { cookie: cookie.slice(0, cookie.indexOf(';')) }

    expect(await (await fetch(`${origin}/before`, { headers })).text()).toBe('registered before pages()')
    expect((await fetch(`${origin}/_kay/health`, { headers })).status).toBe(200)

    const refused = new WebSocket(`ws://127.0.0.1:${url.port}/echo`)

    expect(await new Promise<string>(resolve => refused.addEventListener('error', () => resolve('refused')))).toBe('refused')

    const socket = new WebSocket(`ws://127.0.0.1:${url.port}/echo`, { headers } as unknown as string[])
    const echoed = new Promise(resolve => socket.addEventListener('message', event => resolve(event.data)))

    socket.addEventListener('open', () => socket.send('hi'))
    expect(await echoed).toBe('hi')
    socket.close()

    // Closing the window stops the server as a signal would, its stop hooks run.
    const stopped = next()

    worker.postMessage('stop')
    expect(await stopped).toEqual({ kind: 'stopped' })
    await closed
    expect(fetch(`${origin}/`, { headers })).rejects.toThrow()
  }, 30_000)
})

describe('kay build --desktop', () => {
  it('refuses --desktop beside --compile, before building anything', async () => {
    const build = Bun.spawn([process.execPath, join(repo, 'src/cli.ts'), 'build', tmpdir(), '--compile', 'a', '--desktop', 'b'], { stdout: 'pipe', stderr: 'pipe' })
    const [report, code] = await Promise.all([new Response(build.stderr).text(), build.exited])

    expect(report).toContain('--compile writes a server, and --desktop an app opening its own window; pick one')
    expect(code).toBe(1)
  })

  it('writes one executable opening the app in a window, once the project depends on webview-bun', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kay-desktop-'))

    try {
      await Promise.all(Object.entries({
        'package.json': JSON.stringify({ name: 'notes-app', type: 'module' }),
        'kay.config.ts': 'export default { seo: { name: \'Notes\' }, desktop: { width: 900 } }\n',
        'src/routes/index.kay': 'h1 Notes\n',
        'src/server.ts': 'import { Elysia } from \'elysia\'\nimport { pages } from \'kay/server\'\n\nexport const app = new Elysia().use(await pages()).listen(3000)\n',
      }).map(async ([path, content]) => Bun.write(join(dir, path), content)))
      await mkdir(join(dir, 'node_modules'))
      await Promise.all(['kay', 'elysia'].map(async name => symlink(join(repo, 'node_modules', name), join(dir, 'node_modules', name))))

      const build = async () => {
        const child = Bun.spawn([process.execPath, join(repo, 'src/cli.ts'), 'build', '--no-check', '--desktop', 'notes'], { cwd: dir, stdout: 'pipe', stderr: 'pipe' })
        const [report, code] = await Promise.all([new Response(child.stderr).text(), child.exited])

        return { report, code }
      }

      expect(await build()).toMatchObject({ code: 1, report: expect.stringContaining('a desktop app opens its window through the webview library webview-bun ships, and this project does not depend on it: bun add webview-bun') })

      await symlink(join(repo, 'node_modules/webview-bun'), join(dir, 'node_modules/webview-bun'))

      expect(await build()).toMatchObject({ code: 0, report: expect.stringContaining('compiled notes in ') })
      expect(await Bun.file(join(dir, 'notes')).exists()).toBe(true)
      expect(await Bun.file(join(dir, '.kay/compile/window.ts')).text()).toContain('{"title":"Notes","width":900,"height":768}')
      expect(await Bun.file(join(dir, '.kay/compile/entry.ts')).text()).toContain('startDesktopServer()')

      // Run from elsewhere without its window, as a browser would debug it, then stopped as a closed window stops it.
      const app = Bun.spawn([join(dir, 'notes'), '--no-window'], { cwd: tmpdir(), env: { PATH: process.env.PATH }, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' })

      try {
        const reader = app.stdout.getReader()
        let output = ''

        while (!output.includes('\n')) {
          const { value, done } = await reader.read()

          if (done)
            throw new Error(`the app exited: ${await new Response(app.stderr).text()}`)

          output += new TextDecoder().decode(value)
        }

        const url = (/Open (\S+)/).exec(output)![1]!
        const first = await fetch(url, { redirect: 'manual' })
        const cookie = first.headers.get('set-cookie')!
        const page = await fetch(new URL('/', url), { headers: { cookie: cookie.slice(0, cookie.indexOf(';')) } })

        expect(new URL(url).hostname).toBe('127.0.0.1')
        expect(await page.text()).toContain('<h1>Notes</h1>')
        expect((await fetch(new URL('/', url))).status).toBe(403)

        app.kill('SIGTERM')
        expect(await app.exited).toBe(0)
      }
      finally {
        app.kill()
      }
    }
    finally {
      await rm(dir, { recursive: true, force: true })
    }
  }, 120_000)
})

describe('the window', () => {
  it('names what the machine lacks when the webview library does not load', () => {
    expect(() => createWebview(join(tmpdir(), 'no-such-libwebview.so'), { width: 800, height: 600 })).toThrow('kay: the webview library did not load, on Linux it needs WebKitGTK 6 (webkitgtk-6.0 on Arch, libwebkitgtk-6.0-4 on Debian and Ubuntu), on Windows 10 the WebView2 runtime')
  })
})
