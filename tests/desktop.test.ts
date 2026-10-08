import type { DesktopMessage } from '../src/server/desktop'
import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { describe, expect, it } from 'bun:test'
import { createWebview } from '../src/desktop/webview'
import { openWindow } from '../src/desktop/window'

const repo = join(import.meta.dir, '..')

// The server worker of a desktop executable preferring `port`, and every message it sent so far.
async function startWorker(port: number) {
  const worker = new Worker(join(import.meta.dir, 'fixtures/desktop/worker.ts'))
  const messages: { kind: string, url?: string }[] = []
  const closed = new Promise(resolve => worker.addEventListener('close', resolve))

  worker.addEventListener('message', (event: MessageEvent<{ kind: string }>) => messages.push(event.data))
  worker.postMessage(port)

  const url = await new Promise<URL>((resolve, reject) => {
    worker.addEventListener('message', (event: MessageEvent<DesktopMessage>) => resolve(new URL(event.data.url)), { once: true })
    worker.addEventListener('error', event => reject(new Error(event.message)), { once: true })
  })

  const stop = async () => {
    worker.postMessage('stop')
    await closed
  }

  return { url, messages, stop }
}

// A port nothing listens on, as an app's own usually is.
function freePort(): number {
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response() })
  const { port } = server

  void server.stop(true)

  return port!
}

describe('a desktop server', () => {
  it('listens on the loopback port it prefers and answers the window\'s secret alone, until the window closes', async () => {
    const port = freePort()
    const { url, messages, stop } = await startWorker(port)
    const origin = url.origin
    const secret = url.searchParams.get('kay-desktop')!

    expect(url.hostname).toBe('127.0.0.1')
    expect(url.port).toBe(String(port))
    expect(secret.length).toBeGreaterThanOrEqual(43)

    // Nothing answers another program of the machine, the app's own routes and websockets included.
    expect((await fetch(`${origin}/`)).status).toBe(403)
    expect((await fetch(`${origin}/before`)).status).toBe(403)
    expect((await fetch(`${origin}/_kay/health`)).status).toBe(403)
    expect((await fetch(`${origin}/?kay-desktop=${'x'.repeat(secret.length)}`)).status).toBe(403)
    expect((await fetch(`${origin}/`, { headers: { cookie: `kay-desktop-${port}=nope` } })).status).toBe(403)

    // The window's first request trades the secret for a cookie named after the port, keeping the rest of the query as written.
    const first = await fetch(`${origin}/news?q=a%20b&kay-desktop=${secret}&page=2`, { redirect: 'manual' })
    const cookie = first.headers.get('set-cookie')!

    expect(first.status).toBe(303)
    expect(first.headers.get('location')).toBe('/news?q=a%20b&page=2')
    expect(cookie).toBe(`kay-desktop-${port}=${secret}; Path=/; HttpOnly; SameSite=Strict`)
    expect((await fetch(`${origin}/?kay-desktop=${secret}`, { redirect: 'manual' })).headers.get('location')).toBe('/')

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

    // Closing the window stops the server as a signal would, its stop hooks run once.
    await stop()
    expect(messages.filter(message => message.kind === 'stop hook')).toHaveLength(1)
    await expect(fetch(`${origin}/`, { headers })).rejects.toThrow()
  }, 30_000)

  it('takes another port while the one it prefers is held, as by another launch, under a cookie of its own', async () => {
    const port = freePort()
    const first = await startWorker(port)
    const second = await startWorker(port)

    try {
      expect(first.url.port).toBe(String(port))
      expect(second.url.port).not.toBe(String(port))

      const cookie = (await fetch(second.url, { redirect: 'manual' })).headers.get('set-cookie')!

      expect(cookie).toStartWith(`kay-desktop-${second.url.port}=`)
    }
    finally {
      await Promise.all([first.stop(), second.stop()])
    }
  }, 30_000)
})

describe('kay build --desktop', () => {
  it('refuses --desktop beside --compile, before building anything', async () => {
    const build = Bun.spawn([process.execPath, join(repo, 'src/cli.ts'), 'build', tmpdir(), '--compile', 'a', '--desktop', 'b'], { stdout: 'pipe', stderr: 'pipe' })
    const [report, code] = await Promise.all([new Response(build.stderr).text(), build.exited])

    expect(report).toContain('--compile writes a server, and --desktop an app opening its own window; pick one')
    expect(code).toBe(1)
  })

  it('refuses a base, which a window served from the root never takes, before building anything', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kay-desktop-'))

    try {
      await Bun.write(join(dir, 'kay.config.ts'), 'export default { base: \'/notes\' }\n')

      const build = Bun.spawn([process.execPath, join(repo, 'src/cli.ts'), 'build', dir, '--desktop', join(dir, 'app')], { stdout: 'pipe', stderr: 'pipe' })
      const [report, code] = await Promise.all([new Response(build.stderr).text(), build.exited])

      expect(report).toBe('kay: a desktop app is served to its window from the root, so it takes no base\n')
      expect(code).toBe(1)
    }
    finally {
      await rm(dir, { recursive: true, force: true })
    }
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
      expect(await Bun.file(join(dir, '.kay/compile/entry.ts')).text()).toMatch(/startDesktopServer\(\d+\)/)

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

describe('opening a window', () => {
  const settings = { library: join(tmpdir(), 'no-such-libwebview.so'), title: 'Notes', width: 800, height: 600 }

  it('fails with the server\'s own error when it cannot boot, and says so when it never listens, before any window opens', async () => {
    await expect(openWindow({ ...settings, worker: join(import.meta.dir, 'fixtures/desktop/broken.ts') })).rejects.toThrow('boom at boot')
    await expect(openWindow({ ...settings, worker: join(import.meta.dir, 'fixtures/desktop/silent.ts') })).rejects.toThrow('kay: the server stopped before it listened; does its entry call .listen()?')
  })
})
