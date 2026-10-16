import { existsSync } from 'node:fs'
import { mkdir, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { beforeAll, describe, expect, it } from 'bun:test'
import { alive } from './alive'
import { fixtureCopy } from './scratch'

const cli = join(import.meta.dir, '..', 'src', 'cli.ts')
const SURVEY = '/_kay/action/src/routes/survey.kay'

// What `kay render` printed, each stream apart, and how it exited.
async function render(...args: string[]): Promise<{ out: string, err: string, code: number }> {
  const child = Bun.spawn([process.execPath, cli, 'render', ...args], { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' })
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])

  return { out, err, code }
}

// Kills `kay render` alone once its server printed `pid N` and `ready`, then answers what the server printed until `printed` holds, its pid and kay render's.
async function killedRender(dir: string, url: string, printed: (err: string) => boolean): Promise<{ err: string, pid: number, render: number }> {
  const child = Bun.spawn([process.execPath, cli, 'render', url, dir], { stdin: 'ignore', stdout: 'ignore', stderr: 'pipe' })
  const reader = child.stderr.getReader()
  const decoder = new TextDecoder()
  let err = ''
  let killed = false

  while (!killed || !printed(err)) {
    const { value, done } = await reader.read()

    if (done)
      throw new Error(`kay render's stderr closed early: ${err}`)

    err += decoder.decode(value)

    if (!killed && err.includes('ready')) {
      child.kill('SIGKILL')
      killed = true
    }
  }

  void reader.cancel()

  return { err, pid: Number((/pid (\d+)/).exec(err)![1]), render: child.pid }
}

// The bare fixture, with this config, and an entry of its own when given one.
async function project(config?: string, server?: string): Promise<string> {
  const dir = await fixtureCopy('bare')

  if (config !== undefined)
    await writeFile(join(dir, 'kay.config.ts'), `import { defineConfig } from 'kay/server'\n\nexport default defineConfig(${config})\n`)

  if (server !== undefined)
    await writeFile(join(dir, 'src', 'server.ts'), server)

  return dir
}

describe('kay render', () => {
  let bare: string

  beforeAll(async () => {
    bare = await project()
  })

  it('prints the page and nothing else on stdout', async () => {
    const { out, err, code } = await render('/', bare)

    expect(code).toBe(0)
    expect(out).toStartWith('<!doctype html>')
    expect(out).toContain('<title>Home</title>')
    expect(err).toBe('')
  })

  it('reports a redirect with its location and prints no page', async () => {
    const { out, err, code } = await render('/?next=/later', bare)

    expect(code).toBe(0)
    expect(out).toBe('')
    expect(err).toBe('kay render: 302 Found, to /later\n')
  })

  it('fails on a guard refusing, with its status and answer', async () => {
    const { out, err, code } = await render('/locked', bare)

    expect(code).toBe(1)
    expect(out).toBe('Locked')
    expect(err).toBe('kay render: 403 Forbidden\n')
  })

  it('fails on a path nothing serves', async () => {
    const { err, code } = await render('/nowhere', bare)

    expect(code).toBe(1)
    expect(err).toBe('kay render: 404 Not Found\n')
  })

  it('fails on a page throwing, with the error report the server logs', async () => {
    const { err, code } = await render('/?fail', bare)

    expect(code).toBe(1)
    expect(err).toContain('Error: Kaboom')
    expect(err).toContain(join('src', 'routes', 'index.kay:6'))
    expect(err).toEndWith('kay render: 500 Internal Server Error\n')
  })

  it('posts a body to an action as a form does, and -i prints the answer\'s headers', async () => {
    const { out, err, code } = await render(`${SURVEY}/answer`, bare, '--body', 'tags=a&count=3&agree=true', '-i')

    expect(code).toBe(0)
    expect(out).toBe('')
    expect(err).toStartWith('303 See Other\n')
    expect(err).toContain('x-answer: {"tags":["a"],"count":3,"agree":true}\n')
  })

  it('sends the method given', async () => {
    const { err, code } = await render(`${SURVEY}/answer`, bare, '--method', 'put', '--body', 'tags=a')

    expect(code).toBe(1)
    expect(err).toMatch(/^kay render: 40\d /)
  })

  it('leaves the build of kay build and kay dev alone, and removes its own', async () => {
    const dir = await project()

    await mkdir(join(dir, '.kay', 'client'), { recursive: true })
    await writeFile(join(dir, '.kay', 'client', 'manifest.json'), '{}')

    expect((await render('/', dir)).code).toBe(0)
    expect(existsSync(join(dir, '.kay', 'client', 'manifest.json'))).toBe(true)
    expect((await readdir(join(dir, '.kay'))).filter(name => name.startsWith('render-'))).toEqual([])
  })

  it('refuses what is no path or http URL, and a header without a colon', async () => {
    expect(await render('about', bare)).toMatchObject({ code: 1, err: expect.stringContaining('kay: kay render takes a path such as /about or an http URL, not about') })
    expect(await render('/', bare, '--header', 'nocolon')).toMatchObject({ code: 1, err: expect.stringContaining('kay: --header takes "name: value", not nocolon') })
    expect(await render()).toMatchObject({ code: 1, err: expect.stringContaining('kay: kay render takes the URL to render') })
    expect(await render('//elsewhere/about', bare)).toMatchObject({ code: 1, err: expect.stringContaining('not //elsewhere/about') })
    expect(await render('/', bare, '--method', 'get', '--body', 'a=1')).toMatchObject({ code: 1, err: expect.stringContaining('kay: a GET request has no body, so --body needs another --method, such as POST') })
    expect(await render('/', bare, '--method', 'not a method')).toMatchObject({ code: 1, err: expect.stringContaining('kay: --method takes an HTTP method, not not a method') })
  })
})

describe('kay render under a base path', () => {
  it('renders a path under the base as the proxy in front of the server hands it over, and one already without it', async () => {
    const dir = await project(`{ base: '/docs' }`)
    const [linked, routed] = await Promise.all([render('/docs/survey', dir), render('/survey', dir)])

    expect(linked.code).toBe(0)
    expect(linked.out).toContain('<p>Survey</p>')
    expect(linked.out).toContain('href="/docs/favicon.svg"')
    expect(routed.code).toBe(0)
    expect(routed.out).toContain('<p>Survey</p>')
  })
})

describe('kay render with trailingSlash', () => {
  it('reports the redirect to the trailing slash, and renders the page there', async () => {
    const dir = await project(`{ trailingSlash: 'always' }`)

    expect(await render('/survey', dir)).toMatchObject({ code: 0, out: '', err: 'kay render: 308 Permanent Redirect, to /survey/\n' })
    expect((await render('/survey/', dir)).out).toContain('<p>Survey</p>')
  })
})

describe('kay render with locales', () => {
  it('renders the page in the locale its path names', async () => {
    const dir = await project(`{ i18n: { locales: ['fr', 'en'], defaultLocale: 'fr' } }`)

    await mkdir(join(dir, 'src', 'messages'))
    await Promise.all(['fr', 'en'].map(async locale => writeFile(join(dir, 'src', 'messages', `${locale}.ts`), `import { defineMessages } from 'kay/i18n'\n\nexport default defineMessages({})\n`)))
    const [english, french] = await Promise.all([render('/en', dir), render('/', dir)])

    expect(english.code).toBe(0)
    expect(english.out).toContain('<html lang="en"')
    expect(french.out).toContain('<html lang="fr"')
  })
})

describe('kay render on an entry of the app\'s own', () => {
  const SERVER = `import { Elysia } from 'elysia'
import { pages } from 'kay/server'

const session = new Elysia().derive({ as: 'scoped' }, ({ cookie }) => ({ user: String(cookie.user?.value ?? 'nobody') }))

export const app = new Elysia().use(session).use(await pages()).listen(3000)

console.log('listening on 3000')
`
  const WHO = `--- server
const user = String(ctx.locals.user)
const via = ctx.request.headers.get('x-via') ?? 'none'
---
p {user} via {via}
`
  let dir: string

  beforeAll(async () => {
    dir = await project(undefined, SERVER)
    await writeFile(join(dir, 'src', 'routes', 'who.kay'), WHO)
  })

  it('runs the entry\'s plugins, with the cookies and headers given, and keeps what the server prints off stdout', async () => {
    const { out, err, code } = await render('/who', dir, '--cookie', 'user=ada', '--header', 'x-via: cli')

    expect(code).toBe(0)
    expect(out).toContain('<p>ada via cli</p>')
    expect(out).not.toContain('listening')
    expect(err).toContain('listening on 3000')
  })

  it('renders while another server holds the port the entry asks for', async () => {
    using taken = Bun.serve({ port: 0, fetch: () => new Response('other') })
    const other = await project(undefined, SERVER.replace('3000', String(taken.port)))

    expect((await render('/', other)).code).toBe(0)
  })

  it('gives a full URL\'s host to the request', async () => {
    const dir = await project(undefined, SERVER)

    await writeFile(join(dir, 'src', 'routes', 'host.kay'), `--- server\nconst host = ctx.url.host\n---\np {host}\n`)

    expect((await render('https://shop.example/host', dir)).out).toContain('<p>shop.example</p>')
  })

  it('stops a server ignoring SIGTERM once it answered', async () => {
    const stubborn = await project(undefined, `process.on('SIGTERM', () => {})\nBun.serve({ fetch: () => new Response('up') })\n`)

    expect(await render('/', stubborn)).toMatchObject({ code: 0, out: 'up' })
  }, 15_000)

  // An entry printing its pid, then `ready` once it serves.
  const announced = (server: string) => `console.log(\`pid \${process.pid}\`)\n${server.replace('listening on 3000', 'ready')}`

  it.each([
    ['a bare Bun.serve', `Bun.serve({ fetch: () => new Promise<Response>(() => {}) })\nconsole.log('ready')\n`],
    ['pages() in development', SERVER],
  ])('stops %s once kay render is killed alone', async (_, server) => {
    const { pid } = await killedRender(await project(undefined, announced(server)), '/', () => true)

    try {
      for (let tries = 0; alive(pid) && tries < 100; tries++)
        await Bun.sleep(50)

      expect(alive(pid)).toBe(false)
    }
    finally {
      if (alive(pid))
        process.kill(pid, 'SIGKILL')
    }
  }, 15_000)

  it('removes what a SIGKILLed kay render left, as the next one starts', async () => {
    const dir = await project(undefined, announced(SERVER))
    const { pid, render: killed } = await killedRender(dir, '/', () => true)

    for (let tries = 0; alive(pid) && tries < 100; tries++)
      await Bun.sleep(50)

    const left = async () => [...(await readdir(join(dir, '.kay'))).filter(name => name === `render-${killed}`), ...(await readdir(tmpdir())).filter(name => name.startsWith(`kay-render-${killed}-`))]

    expect(await left()).toHaveLength(2)
    expect((await render('/', dir)).code).toBe(0)
    expect(await left()).toEqual([])
  }, 15_000)

  it('names kay render as the process gone when a production server drains', async () => {
    const draining = await project(undefined, announced(SERVER.replace('pages()', 'pages({ dev: false })')))

    await writeFile(join(draining, 'src', 'routes', 'hang.kay'), `--- server\nawait new Promise(() => {})\n---\np never\n`)

    const { err, pid } = await killedRender(draining, '/hang', printed => printed.includes('exited; finishing open requests'))

    process.kill(pid, 'SIGKILL')

    expect(err).toContain('kay render exited; finishing open requests')
  }, 15_000)

  it('fails when the entry exits before it serves', async () => {
    const broken = await project(undefined, `throw new Error('no database')\n`)
    const { err, code } = await render('/', broken)

    expect(code).toBe(1)
    expect(err).toContain('no database')
    expect(err).toContain('kay render: the server exited with code 1 before it served')
  })
})
