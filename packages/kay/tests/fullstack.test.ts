import { afterAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build } from '../src/build/index'
import { actionStub } from '../src/dom/action'
import { defineEnv } from '../src/server/env'
import { testApp } from '../src/test/index'

const fixtureDir = mkdtempSync(join(tmpdir(), 'kay-v2-fullstack-'))

function writeFixture(rel: string, content: string): void {
  const abs = join(fixtureDir, rel)
  mkdirSync(join(abs, '..'), { recursive: true })
  writeFileSync(abs, content)
}

// Create a full-stack fixture exercising every Milestone 2 feature
writeFixture('src/schema.ts', `
import type { StandardSchemaV1 } from '@kayjs/kay/server'

// Minimal zero-dep Standard Schema v1 validator (same protocol as Zod/Valibot/ArkType)
export function objectSchema<T extends Record<string, (v: unknown) => string | undefined>>(rules: T): StandardSchemaV1<Record<string, unknown>, { [K in keyof T]: string }> {
  return {
    '~standard': {
      version: 1,
      vendor: 'test',
      validate(value: unknown) {
        if (typeof value !== 'object' || value === null)
          return { issues: [{ message: 'Expected object' }] }
        const obj = value as Record<string, unknown>
        const issues: { message: string; path: string[] }[] = []
        const out: Record<string, string> = {}
        for (const [k, check] of Object.entries(rules)) {
          const err = check(obj[k])
          if (err !== undefined) issues.push({ message: err, path: [k] })
          else out[k] = String(obj[k])
        }
        return issues.length > 0 ? { issues } : { value: out as { [K in keyof T]: string } }
      },
    },
  }
}
`)

writeFixture('src/routes/_layout.tsx', `
import { Head, type KayChild } from '@kayjs/kay'

export default function RootLayout({ children }: { children?: KayChild }) {
  return (
    <>
      <Head>
        <title>Default Site</title>
        <meta name="generator" content="kay-v2" />
      </Head>
      <div class="root-layout">{children}</div>
    </>
  )
}
`)

writeFixture('src/routes/_404.tsx', `
export default function NotFound() {
  return <main class="not-found"><h1>Custom 404</h1></main>
}
`)

writeFixture('src/routes/_error.tsx', `
export default function ErrorPage({ error }: { error: unknown }) {
  const msg = error instanceof Error ? error.message : String(error)
  return <main class="error-page"><h1>Oops</h1><p>{msg}</p></main>
}
`)

writeFixture('src/routes/_middleware.ts', `
import type { Middleware } from '@kayjs/kay/server'

const middleware: Middleware = async (ctx, next) => {
  ctx.locals.requestTag = 'from-root-mw'
  const res = await next()
  res.headers.set('x-root-mw', '1')
  return res
}
export default middleware
`)

writeFixture('src/routes/index.tsx', `
import { Head } from '@kayjs/kay'

export default function Home({ locals }: { locals: Record<string, unknown> }) {
  return (
    <>
      <Head><title>Home Page</title></Head>
      <h1>Home ({String(locals.requestTag)})</h1>
    </>
  )
}
`)

writeFixture('src/routes/posts/[slug].tsx', `
import { Head } from '@kayjs/kay'

export const prerender = true

export function paths() {
  return ['/posts/hello-world']
}

export default function Post({ params }: { params: Record<string, string> }) {
  return (
    <>
      <Head><title>Post: {params.slug}</title></Head>
      <article data-slug={params.slug}>Slug is {params.slug}</article>
    </>
  )
}
`)

writeFixture('src/routes/docs/[...path].tsx', `
export default function Docs({ params }: { params: Record<string, string> }) {
  return <div class="docs">Docs path: {params.path}</div>
}
`)

writeFixture('src/routes/admin/_layout.tsx', `
import type { KayChild } from '@kayjs/kay'

export default function AdminLayout({ children }: { children?: KayChild }) {
  return <section class="admin-layout">{children}</section>
}
`)

writeFixture('src/routes/admin/_middleware.ts', `
import type { Middleware } from '@kayjs/kay/server'

const adminGuard: Middleware = async (ctx, next) => {
  if (ctx.cookies.get('session') !== 'valid-token')
    return ctx.redirect('/login', 302)
  ctx.locals.role = 'admin'
  return next()
}
export default adminGuard
`)

writeFixture('src/routes/admin/index.tsx', `
export default function AdminHome({ locals }: { locals: Record<string, unknown> }) {
  return <h1>Admin ({String(locals.role)})</h1>
}
`)

writeFixture('src/routes/boom.tsx', `
export default function Boom() {
  throw new Error('kaboom!')
}
`)

writeFixture('src/routes/stream.tsx', `
import { Suspense } from '@kayjs/kay'

async function SlowWidget() {
  await Bun.sleep(25)
  return <p class="loaded">Streamed content ready!</p>
}

export default function StreamPage() {
  return (
    <main>
      <h1>Streaming</h1>
      <Suspense fallback={<p class="fallback">Loading...</p>}>
        <SlowWidget />
      </Suspense>
    </main>
  )
}
`)

writeFixture('src/routes/api/ping.ts', `
import type { RequestContext } from '@kayjs/kay/server'

export function GET(ctx: RequestContext) {
  return ctx.json({ pong: true, tag: ctx.locals.requestTag })
}

export function POST(ctx: RequestContext) {
  ctx.cookies.set('session', 'valid-token')
  return ctx.json({ signedIn: true })
}
`)

writeFixture('src/actions/notes.ts', `
import { action } from '@kayjs/kay/server'
import { objectSchema } from '../schema'

const SECRET_SERVER_MARKER = 'TOP_SECRET_DB_PASSWORD_NEVER_IN_CLIENT'
const notes: string[] = []

const noteSchema = objectSchema({
  title: v => (typeof v === 'string' && v.trim().length > 0 ? undefined : 'Title is required'),
})

export const addNote = action(noteSchema, async (input, ctx) => {
  void SECRET_SERVER_MARKER
  notes.push(input.title.trim())
  ctx.cookies.set('last_note', input.title.trim())
  return { count: notes.length, title: input.title.trim() }
})
`)

writeFixture('src/components/NoteForm.tsx', `
import { signal } from '@kayjs/kay'
import { addNote } from '../actions/notes'

export function NoteForm() {
  const status = signal('idle')
  async function submit() {
    const res = await addNote({ title: 'From Island' })
    status.value = res.ok ? res.data.title : res.error
  }
  return (
    <form action={addNote} method="post">
      <button type="button" onClick={submit}>{status.value}</button>
    </form>
  )
}
`)

writeFixture('src/routes/notes.tsx', `
import { addNote } from '../actions/notes'
import { NoteForm } from '../components/NoteForm'

export default function NotesPage() {
  return (
    <div>
      <form id="ssr-form" action={addNote} method="post">
        <input name="title" />
      </form>
      <NoteForm />
    </div>
  )
}
`)

writeFixture('src/routes/admin/reports/_middleware.ts', `
import type { Middleware } from '@kayjs/kay/server'

const reportsMiddleware: Middleware = async (ctx, next) => {
  ctx.locals.chain = [ctx.locals.requestTag, ctx.locals.role].join('>')
  return next()
}
export default reportsMiddleware
`)

writeFixture('src/routes/admin/reports/index.tsx', `
import { action } from '@kayjs/kay/server'

export const reportChain = action(async ctx => ctx.locals.chain)

export default function Reports() {
  return <form action={reportChain} method="post"><button type="submit">Run</button></form>
}
`)

afterAll(() => {
  rmSync(fixtureDir, { recursive: true, force: true })
})

describe('Kay v2 Milestone 2 full-stack features', () => {
  test('routing, nested layouts, middleware, cookies, Head, Suspense, actions, CSRF, prerender, and client stub stripping', async () => {
    const app = await testApp({ root: fixtureDir, outDir: 'dist' })

    // 1. Home page: root middleware locals + <Head> title deduplication + security headers
    const homeRes = await app.get('/')
    expect(homeRes.status).toBe(200)
    expect(homeRes.headers.get('x-root-mw')).toBe('1')
    expect(homeRes.headers.get('x-content-type-options')).toBe('nosniff')
    expect(homeRes.headers.get('x-frame-options')).toBe('SAMEORIGIN')
    const homeHtml = await homeRes.text()
    expect(homeHtml).toContain('<title>Home Page</title>')
    expect(homeHtml).not.toContain('<title>Default Site</title>')
    expect(homeHtml).toContain('<meta name="generator" content="kay-v2">')
    expect(homeHtml).toContain('<div class="root-layout"><h1>Home (from-root-mw)</h1></div>')

    // 2. Dynamic [slug] route + prerendered static HTML
    const prePath = join(fixtureDir, 'dist/prerendered/posts/hello-world/index.html')
    expect(existsSync(prePath)).toBe(true)
    const preRes = await app.get('/posts/hello-world')
    expect(preRes.status).toBe(200)
    expect(await preRes.text()).toContain('Slug is hello-world')

    // Unlisted param on a prerendered dynamic route returns 404 (#3526 box 10)
    const dynRes = await app.get('/posts/other-post')
    expect(dynRes.status).toBe(404)

    // 3. Catch-all [...path] route
    const docsRes = await app.get('/docs/guide/getting-started')
    expect(docsRes.status).toBe(200)
    expect(await docsRes.text()).toContain('Docs path: guide/getting-started')

    // 4. Nested admin middleware guard + cookie jar session persistence + nested layout
    const denied = await app.get('/admin')
    expect(denied.status).toBe(302)
    expect(denied.headers.get('location')).toBe('/login')

    // Sign in via .ts API route (sets cookie in testApp cookie jar!)
    const pingRes = await app.get('/api/ping')
    expect(await pingRes.json()).toEqual({ pong: true, tag: 'from-root-mw' })

    const signInRes = await app.post('/api/ping')
    expect(signInRes.status).toBe(200)
    expect(app.cookies.get('session')).toBe('valid-token')

    const adminRes = await app.get('/admin')
    expect(adminRes.status).toBe(200)
    const adminHtml = await adminRes.text()
    expect(adminHtml).toContain('<div class="root-layout"><section class="admin-layout"><h1>Admin (admin)</h1></section></div>')

    // 5. Custom _404.tsx and _error.tsx
    const nfRes = await app.get('/does-not-exist')
    expect(nfRes.status).toBe(404)
    expect(await nfRes.text()).toContain('Custom 404')

    const errRes = await app.get('/boom')
    expect(errRes.status).toBe(500)
    const errHtml = await errRes.text()
    expect(errHtml).toContain('Oops')
    expect(errHtml).toContain('kaboom!')

    // 6. Streaming <Suspense> (inline-free strict-CSP swap via <kay-s> + <template data-ks>)
    const streamRes = await app.get('/stream')
    expect(streamRes.status).toBe(200)
    const streamHtml = await streamRes.text()
    expect(streamHtml).toContain('<kay-s id="k-s-0"><p class="fallback">Loading...</p></kay-s>')
    expect(streamHtml).toContain('<template data-ks="0"><p class="loaded">Streamed content ready!</p></template>')
    expect(streamHtml).toContain('s.replaceWith(n.content)')

    // 7. Unified Standard-Schema action(): SSR <form action>, FormData validation, RPC JSON, CSRF block, client stub stripping!
    const notesRes = await app.get('/notes')
    const notesHtml = await notesRes.text()
    const actionMatch = /action="(\/_kay\/action\/[^"]+)"/.exec(notesHtml)
    expect(actionMatch).not.toBeNull()
    const actionUrl = actionMatch![1]!

    // Cross-site CSRF check
    const csrfRes = await app.fetch(actionUrl, {
      method: 'POST',
      headers: { 'origin': 'https://evil.example', 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'hacked' }),
    })
    expect(csrfRes.status).toBe(403)

    // Validation failure (400 + fieldErrors)
    const badRes = await app.post(actionUrl, { title: '   ' })
    expect(badRes.status).toBe(400)
    const badJson = await badRes.json() as { ok: boolean, fieldErrors: Record<string, string> }
    expect(badJson.ok).toBe(false)
    expect(badJson.fieldErrors.title).toBe('Title is required')

    // Valid FormData submission (progressive form)
    const formRes = await app.submit(actionUrl, { title: 'First Note' })
    expect(formRes.status).toBe(200)
    expect(await formRes.json()).toEqual({ ok: true, data: { count: 1, title: 'First Note' } })
    expect(app.cookies.get('last_note')).toBe('First Note')

    // Valid JSON RPC call
    const rpcRes = await app.post(actionUrl, { title: 'Second Note' })
    expect(rpcRes.status).toBe(200)
    expect(await rpcRes.json()).toEqual({ ok: true, data: { count: 2, title: 'Second Note' } })

    // Verify client bundle stripped server-only code & secrets from actions/notes.ts!
    const clientAssets = app.manifest!.assets.map(f => readFileSync(join(fixtureDir, 'dist/client', f), 'utf8')).join('\n')
    expect(clientAssets).not.toContain('TOP_SECRET_DB_PASSWORD_NEVER_IN_CLIENT')
    expect(clientAssets).toContain(actionUrl)
  })

  test('an action runs its folder _middleware.ts chain outermost first, and an action outside routes runs none', async () => {
    const app = await testApp({ root: fixtureDir })
    const chainUrl = app.manifest!.actions.find(a => a.exportName === 'reportChain')!.url
    expect((await app.post(chainUrl, {})).status).toBe(302)
    app.cookies.set('session', 'valid-token')
    expect(await (await app.post(chainUrl, {})).json()).toEqual({ ok: true, data: 'from-root-mw>admin' })

    const noteUrl = app.manifest!.actions.find(a => a.exportName === 'addNote')!.url
    const noteRes = await app.post(noteUrl, { title: 'Outside routes' })
    expect(noteRes.status).toBe(200)
    expect(noteRes.headers.get('x-root-mw')).toBeNull()
  })

  test('a cross-site action POST is refused before its _middleware.ts chain runs', async () => {
    const app = await testApp({ root: fixtureDir })
    const chainUrl = app.manifest!.actions.find(a => a.exportName === 'reportChain')!.url
    const res = await app.fetch(chainUrl, {
      method: 'POST',
      headers: { 'origin': 'https://evil.example', 'content-type': 'application/json' },
      body: '{}',
    })
    expect(res.status).toBe(403)
    expect(res.headers.get('x-root-mw')).toBeNull()
  })

  test('defineEnv validates and freezes typed environment variables', () => {
    const envSchema = {
      '~standard': {
        version: 1 as const,
        vendor: 'test',
        validate(raw: unknown) {
          const obj = raw as Record<string, string | undefined>
          if (!obj.DATABASE_URL)
            return { issues: [{ message: 'Required', path: ['DATABASE_URL'] }] }
          return { value: { DATABASE_URL: obj.DATABASE_URL, PORT: Number(obj.PORT ?? 3000) } }
        },
      },
    }

    expect(() => defineEnv(envSchema, {})).toThrow(/DATABASE_URL: Required/)
    const env = defineEnv(envSchema, { DATABASE_URL: 'postgres://local/db', PORT: '4000' })
    expect(env).toEqual({ DATABASE_URL: 'postgres://local/db', PORT: 4000 })
    expect(Object.isFrozen(env)).toBe(true)
  })

  test('static export (--static) writes static HTML, client assets, and .br/.gz sidecars directly into outDir', async () => {
    const staticDir = mkdtempSync(join(tmpdir(), 'kay-v2-static-only-'))
    try {
      mkdirSync(join(staticDir, 'src/routes/posts'), { recursive: true })
      writeFileSync(join(staticDir, 'src/routes/index.tsx'), 'export default function Home() { return <main><h1>Static Home</h1></main> }')
      writeFileSync(join(staticDir, 'src/routes/posts/[slug].tsx'), `
        export const prerender = true
        export function paths() { return ['/posts/hello-world'] }
        export default function Post({ params }: { params: { slug: string } }) {
          return <article>Slug is {params.slug}</article>
        }
      `)
      await build({ root: staticDir, outDir: 'dist-static', static: true })
      const homeHtmlPath = join(staticDir, 'dist-static/index.html')
      expect(existsSync(join(staticDir, 'dist-static/server'))).toBe(false)
      expect(existsSync(homeHtmlPath)).toBe(true)
      expect(existsSync(join(staticDir, 'dist-static/posts/hello-world/index.html'))).toBe(true)
      expect(existsSync(`${homeHtmlPath}.br`)).toBe(true)
      expect(existsSync(`${homeHtmlPath}.gz`)).toBe(true)
    }
    finally {
      rmSync(staticDir, { recursive: true, force: true })
    }
  })

  test('progressive form action redirects 303 back to referer behind HTTPS proxy or trustedOrigins, never open-redirects', async () => {
    const app = await testApp({
      root: fixtureDir,
      outDir: 'dist-proxy',
      trustProxy: true,
      trustedOrigins: ['https://trusted.example'],
    })
    const notesHtml = await (await app.get('/notes')).text()
    const actionUrl = /action="(\/_kay\/action\/[^"]+)"/.exec(notesHtml)![1]!

    // 1. Both X-Forwarded-Proto and X-Forwarded-Host sent
    const bothFwd = await app.submit(actionUrl, { title: 'Via Proxy' }, {
      'origin': 'https://artifact.localhost',
      'referer': 'https://artifact.localhost/notes?page=2',
      'x-forwarded-proto': 'https',
      'x-forwarded-host': 'artifact.localhost',
    })
    expect(bothFwd.status).toBe(303)
    expect(bothFwd.headers.get('location')).toBe('https://artifact.localhost/notes?page=2')

    // 2. Only X-Forwarded-Proto sent with Host preserved
    const protoOnly = await app.submit(actionUrl, { title: 'Proto Only' }, {
      'host': 'artifact.localhost',
      'origin': 'https://artifact.localhost',
      'referer': 'https://artifact.localhost/notes',
      'x-forwarded-proto': 'https',
    })
    expect(protoOnly.status).toBe(303)
    expect(protoOnly.headers.get('location')).toBe('https://artifact.localhost/notes')

    // 3. Neither forwarded header sent, referer origin in trustedOrigins
    const trusted = await app.submit(actionUrl, { title: 'Trusted' }, {
      'origin': 'https://trusted.example',
      'referer': 'https://trusted.example/dashboard',
    })
    expect(trusted.status).toBe(303)
    expect(trusted.headers.get('location')).toBe('https://trusted.example/dashboard')

    // 4. Referer from an untrusted origin still gets JSON, never an open redirect
    const untrustedRef = await app.submit(actionUrl, { title: 'Untrusted Ref' }, {
      'origin': 'http://localhost',
      'referer': 'https://evil.example/phish',
    })
    expect(untrustedRef.status).toBe(200)
    expect(untrustedRef.headers.get('location')).toBeNull()
    expect(await untrustedRef.json()).toMatchObject({ ok: true, data: { title: 'Untrusted Ref' } })
  })

  test('build() and testApp() with outDir outside root resolve routes npm imports and kay/build', async () => {
    const appDir = mkdtempSync(join(tmpdir(), 'kay-v2-ext-app-'))
    const externalOutDir = mkdtempSync(join(tmpdir(), 'kay-v2-ext-out-'))
    try {
      mkdirSync(join(appDir, 'node_modules/fake-ext-pkg'), { recursive: true })
      writeFileSync(
        join(appDir, 'node_modules/fake-ext-pkg/package.json'),
        JSON.stringify({ name: 'fake-ext-pkg', version: '1.0.0', type: 'module', main: './index.js' }),
      )
      writeFileSync(
        join(appDir, 'node_modules/fake-ext-pkg/index.js'),
        'export function greet(name) { return `ext:${name}` }\n',
      )

      mkdirSync(join(appDir, 'src/routes'), { recursive: true })
      writeFileSync(
        join(appDir, 'src/routes/index.tsx'),
        `import { greet } from 'fake-ext-pkg'
import { resolveKaySpecifier } from '@kayjs/kay/build'

export default function Home() {
  const hasBuild = typeof resolveKaySpecifier === 'function'
  return <main>{greet('world')}:{String(hasBuild)}</main>
}
`,
      )

      const app = await testApp({ root: appDir, outDir: externalOutDir })
      const res = await app.get('/')
      expect(res.status).toBe(200)
      expect(await res.text()).toContain('<main>ext:world:true</main>')
    }
    finally {
      rmSync(appDir, { recursive: true, force: true })
      rmSync(externalOutDir, { recursive: true, force: true })
    }
  })
})

describe('calling an action from an island', () => {
  const withFetch = async (fake: (url: string, init: RequestInit) => Promise<Response>, run: () => Promise<void>) => {
    const real = globalThis.fetch
    globalThis.fetch = fake as typeof fetch
    try {
      await run()
    }
    finally {
      globalThis.fetch = real
    }
  }

  test('a FormData with a file reaches the action and its data comes back', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kay-action-file-'))
    try {
      mkdirSync(join(dir, 'src/routes'), { recursive: true })
      writeFileSync(join(dir, 'src/routes/upload.ts'), `
        import { action } from '@kayjs/kay/server'
        const form = { '~standard': { version: 1, vendor: 'test', validate: (value: unknown) => ({ value: value as { avatar: File, name: string } }) } }
        export const upload = action(form, async input => ({ file: input.avatar.name, size: input.avatar.size, name: input.name }))
      `)
      const app = await testApp({ root: dir })
      const url = app.manifest!.actions.find(a => a.exportName === 'upload')!.url
      const form = new FormData()
      form.set('name', 'Ada')
      form.set('avatar', new File(['12345'], 'me.png', { type: 'image/png' }))
      await withFetch((u, init) => app.fetch(u, init), async () => {
        expect(await actionStub<FormData, unknown>(url)(form)).toEqual({ ok: true, data: { file: 'me.png', size: 5, name: 'Ada' } })
      })
    }
    finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('a network failure resolves to an error result', async () => {
    await withFetch(async () => {
      throw new TypeError('Failed to fetch')
    }, async () => {
      expect(await actionStub('/_kay/action/x')({})).toEqual({ ok: false, status: 0, error: 'Failed to fetch' })
    })
  })

  test('a response that is not an action result resolves to an error result', async () => {
    await withFetch(async () => new Response('<h1>Bad gateway</h1>', { status: 502, statusText: 'Bad Gateway' }), async () => {
      expect(await actionStub('/_kay/action/x')({})).toEqual({ ok: false, status: 502, error: 'Bad Gateway' })
    })
  })

  test('a redirect navigates and never resolves with made-up data', async () => {
    const assigned: string[] = []
    const realLocation = (globalThis as { location?: unknown }).location
    ;(globalThis as { location?: unknown }).location = { assign: (u: string) => assigned.push(u) }
    try {
      const redirected = Object.defineProperties(new Response('<p>home</p>'), { redirected: { value: true }, url: { value: 'http://localhost/home' } })
      await withFetch(async () => redirected, async () => {
        const settled = await Promise.race([actionStub('/_kay/action/x')({}), Bun.sleep(20).then(() => 'pending')])
        expect(settled).toBe('pending')
        expect(assigned).toEqual(['http://localhost/home'])
      })
    }
    finally {
      ;(globalThis as { location?: unknown }).location = realLocation
    }
  })
})

describe('form posts parsed for an action schema', () => {
  let app: Awaited<ReturnType<typeof testApp>>
  let url: string
  const dir = mkdtempSync(join(tmpdir(), 'kay-form-parse-'))
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  const post = async (fields: [string, string][]) => {
    const res = await app.fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', 'accept': 'application/json' },
      body: new URLSearchParams(fields).toString(),
    })
    return res.json() as Promise<{ ok: boolean, data?: Record<string, unknown>, fieldErrors?: Record<string, string> }>
  }

  test('fields named like Object members parse as ordinary values', async () => {
    mkdirSync(join(dir, 'src/routes'), { recursive: true })
    writeFileSync(join(dir, 'src/routes/form.ts'), `
      import { action } from '@kayjs/kay/server'
      // Each listed field must be a string, an array ('array') or a string of 3 or more characters ('long'); the parsed body comes back as is.
      const shape = (fields: Record<string, 'string' | 'array' | 'long'>) => ({ '~standard': { version: 1, vendor: 'test', validate(value: Record<string, unknown>) {
        const issues = Object.entries(fields).flatMap(([k, t]) => {
          const v = Object.prototype.hasOwnProperty.call(value, k) ? value[k] : undefined
          if (t === 'array')
            return Array.isArray(v) ? [] : [{ message: k + ' must be array', path: [k] }]
          if (typeof v !== 'string')
            return [{ message: k + ' must be string', path: [k] }]
          return t === 'long' && v.length < 3 ? [{ message: k + ' is too short', path: [k] }] : []
        })
        return issues.length > 0 ? { issues } : { value: Object.fromEntries(Object.entries(value)) }
      } } })
      export const members = action(shape({ constructor: 'string', __proto__: 'string', hasOwnProperty: 'string', toString: 'string' }), input => input)
      export const choices = action(shape({ title: 'long', tags: 'array', pick: 'array' }), input => input)
      let validateRuns = 0
      export function resetRuns() { validateRuns = 0 }
      export function getRuns() { return validateRuns }
      const countedSchema = {
        '~standard': {
          version: 1 as const,
          vendor: 'test',
          async validate(raw: unknown) {
            validateRuns++
            const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
            const issues: Array<{ message: string, path: string[], code?: string, expected?: string }> = []
            if (typeof o.email !== 'string' || !o.email.includes('@'))
              issues.push({ message: 'Invalid email', path: ['email'], code: 'invalid_string' })
            if (o.tags !== undefined && !Array.isArray(o.tags))
              issues.push({ message: 'Expected array, received string', path: ['tags'], code: 'invalid_type', expected: 'array' })
            else if (!Object.prototype.hasOwnProperty.call(o, 'tags'))
              issues.push({ message: 'Required', path: ['tags'], code: 'invalid_type', expected: 'array' })
            return issues.length > 0 ? { issues } : { value: o }
          },
        },
      }
      export const signup = action(countedSchema, input => input)
    `)
    app = await testApp({ root: dir })
    url = app.manifest!.actions.find(a => a.exportName === 'members')!.url
    const fields: [string, string][] = [['constructor', 'c'], ['__proto__', 'p'], ['hasOwnProperty', 'h'], ['toString', 't']]
    expect(await post(fields)).toEqual({ ok: true, data: Object.fromEntries(fields) })
    expect((await post(fields.slice(1))).fieldErrors).toEqual({ constructor: 'constructor must be string' })
  })

  test.each([
    ['no box ticked', [], []],
    ['one box ticked', [['tags', 'a']], ['a']],
    ['two boxes ticked', [['tags', 'a'], ['tags', 'b']], ['a', 'b']],
  ] as [string, [string, string][], string[]][])('a checkbox group with %s parses as an array', async (_, tags, expected) => {
    url = app.manifest!.actions.find(a => a.exportName === 'choices')!.url
    expect(await post([['title', 'Tea'], ...tags, ['pick', 'x']])).toEqual({ ok: true, data: { title: 'Tea', tags: expected, pick: ['x'] } })
  })

  test('a missing string field still fails instead of becoming an array', async () => {
    url = app.manifest!.actions.find(a => a.exportName === 'choices')!.url
    expect((await post([['tags', 'a'], ['pick', 'x']])).fieldErrors).toEqual({ title: 'title must be string' })
  })

  test('a string field failing on its value keeps its own error beside a checkbox the retry fixed', async () => {
    url = app.manifest!.actions.find(a => a.exportName === 'choices')!.url
    expect((await post([['title', 'ab'], ['tags', 'a'], ['pick', 'x']])).fieldErrors).toEqual({ title: 'title is too short' })
  })

  test('a JSON body is taken as sent, a single value staying a single value', async () => {
    url = app.manifest!.actions.find(a => a.exportName === 'choices')!.url
    expect((await (await app.post(url, { title: 'Tea', tags: 'a', pick: ['x'] })).json() as { fieldErrors: unknown }).fieldErrors).toEqual({ tags: 'tags must be array' })
  })

  test('#3606: invalid non-array form fields run schema validation once, and mixed array retries run at most twice', async () => {
    const mod = await app.import('src/routes/form.ts') as { resetRuns: () => void, getRuns: () => number }
    url = app.manifest!.actions.find(a => a.exportName === 'signup')!.url

    // Non-array validation failure (tags already an array of 2 values, email invalid): runs ONCE.
    mod.resetRuns()
    const badEmail = await post([['email', 'nope'], ['tags', 'a'], ['tags', 'b']])
    expect(badEmail.fieldErrors).toEqual({ email: 'Invalid email' })
    expect(mod.getRuns()).toBe(1)

    // Missing array field (0 boxes checked) + invalid email: retries only `tags` once (2 runs total, never 3).
    mod.resetRuns()
    const missingArrayAndBadEmail = await post([['email', 'nope']])
    expect(missingArrayAndBadEmail.fieldErrors).toEqual({ email: 'Invalid email' })
    expect(mod.getRuns()).toBe(2)

    // Valid email + 0 boxes checked (Zod-like `expected: 'array', message: 'Required'`): succeeds in 2 runs with tags=[].
    mod.resetRuns()
    const okZero = await post([['email', 'a@b.com']])
    expect(okZero).toEqual({ ok: true, data: { email: 'a@b.com', tags: [] } })
    expect(mod.getRuns()).toBe(2)
  })
})

describe('zero-JS action deny flash, RGPD filtering, and cookie lifecycle (#3627)', () => {
  test('ctx.deny() flashes and 303-redirects for zero-JS forms, strips French RGPD sensitive fields, and preserves JSON & custom Responses', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kay-deny-flash-'))
    try {
      mkdirSync(join(dir, 'src/routes'), { recursive: true })
      mkdirSync(join(dir, 'src/actions'), { recursive: true })

      writeFileSync(join(dir, 'src/actions/account.ts'), `
        import { action } from '@kayjs/kay/server'
        const passAll = { '~standard': { version: 1 as const, vendor: 'test', validate: (v: unknown) => ({ value: v as Record<string, string> }) } }
        export const register = action(passAll, async (_input, ctx) => ctx.deny(422, 'Email déjà utilisé', { email: 'Déjà pris' }))
        export const forbidden = action(async (ctx) => ctx.deny(403, 'Accès refusé'))
        export const customRedirect = action(async (ctx) => ctx.redirect('/thanks', 303))
        export const download = action(async () => new Response('PDF-BYTES', { status: 200, headers: { 'content-type': 'application/pdf' } }))
      `)
      writeFileSync(join(dir, 'src/routes/index.tsx'), `
        import { getActionError } from '@kayjs/kay/server'
        import type { PageProps } from '@kayjs/kay/server'
        import { customRedirect, download, forbidden, register } from '../actions/account'
        export default function Signup({ locals }: PageProps) {
          const err = getActionError(locals)
          return (
            <main>
              {err && <p class="flash">{err.error}|{err.fieldErrors?.email ?? ''}|{JSON.stringify(err.values ?? {})}</p>}
              <form action={register} method="post"><button>Register</button></form>
              <form action={forbidden} method="post"><button>Forbid</button></form>
              <form action={customRedirect} method="post"><button>Go</button></form>
              <form action={download} method="post"><button>DL</button></form>
            </main>
          )
        }
      `)

      const app = await testApp({ root: dir })
      const urlOf = (name: string) => app.manifest!.actions.find(a => a.exportName === name)!.url

      // 1. Zero-JS form submit returning ctx.deny() -> 303 + flash cookie with French sensitive fields stripped, safe words kept
      const fd = new FormData()
      fd.set('email', 'alice@example.com')
      fd.set('description', 'hello')
      fd.set('subscribe', 'yes')
      fd.set('article', 'news')
      fd.set('souvenir', 'paris')
      fd.set('avenir', 'bright')
      fd.set('mot_de_passe', 's1')
      fd.set('motDePasse', 's2')
      fd.set('mdp', 's3')
      fd.set('user_mdp', 's4')
      fd.set('rib', 'FR76')
      fd.set('mon_rib', 'FR76')
      fd.set('nir', '1850175')
      fd.set('numero_nir', '1850175')
      fd.set('carte_bancaire', '4111')
      fd.set('secu', '185')
      fd.set('sécu', '185')
      fd.set('cb', '4111')
      fd.set('code_cb', '123')
      fd.set('bic', 'BNPAFRPP')
      fd.set('sepa', 'MANDAT')
      fd.set('cle_api', 'k1')
      fd.set('clé', 'k2')
      fd.set('date_naissance', '1990-01-01')
      fd.set('santé', 'private')

      const denyFormRes = await app.fetch(new Request(`http://localhost${urlOf('register')}`, {
        method: 'POST',
        headers: { accept: 'text/html', origin: 'http://localhost', referer: 'http://localhost/' },
        body: fd,
      }))
      expect(denyFormRes.status).toBe(303)
      expect(denyFormRes.headers.get('location')).toBe('http://localhost/')

      const pageHtml = await (await app.get('/')).text()
      const flashMatch = /<p class="flash">([^<]+)<\/p>/.exec(pageHtml)
      expect(flashMatch).not.toBeNull()
      const [errText, fieldErr, valuesJson] = flashMatch![1]!.replaceAll('&quot;', '"').split('|')
      expect(errText).toBe('Email déjà utilisé')
      expect(fieldErr).toBe('Déjà pris')
      expect(JSON.parse(valuesJson!)).toEqual({
        email: 'alice@example.com',
        description: 'hello',
        subscribe: 'yes',
        article: 'news',
        souvenir: 'paris',
        avenir: 'bright',
      })

      // 2. Schema-less action ctx.deny() on zero-JS form -> 303 + flash without fieldErrors
      const forbidRes = await app.fetch(new Request(`http://localhost${urlOf('forbidden')}`, {
        method: 'POST',
        headers: { accept: 'text/html', origin: 'http://localhost', referer: 'http://localhost/' },
      }))
      expect(forbidRes.status).toBe(303)
      expect(await (await app.get('/')).text()).toContain('Accès refusé||{}')

      // 3. JSON client or missing Referer preserves ctx.deny() JSON response & status
      const jsonDeny = await app.post(urlOf('register'), { email: 'a@b.com' })
      expect(jsonDeny.status).toBe(422)
      expect(await jsonDeny.json()).toEqual({ ok: false, status: 422, error: 'Email déjà utilisé', fieldErrors: { email: 'Déjà pris' } })

      const noRefDeny = await app.fetch(new Request(`http://localhost${urlOf('forbidden')}`, {
        method: 'POST',
        headers: { accept: 'text/html', origin: 'http://localhost' },
      }))
      expect(noRefDeny.status).toBe(403)
      expect(await noRefDeny.json()).toEqual({ ok: false, status: 403, error: 'Accès refusé' })

      // 4. Custom non-deny Responses (redirects, downloads) pass through untouched
      const redirRes = await app.fetch(new Request(`http://localhost${urlOf('customRedirect')}`, {
        method: 'POST',
        headers: { accept: 'text/html', origin: 'http://localhost', referer: 'http://localhost/' },
      }))
      expect(redirRes.status).toBe(303)
      expect(redirRes.headers.get('location')).toBe('/thanks')

      const dlRes = await app.fetch(new Request(`http://localhost${urlOf('download')}`, {
        method: 'POST',
        headers: { accept: 'text/html', origin: 'http://localhost', referer: 'http://localhost/' },
      }))
      expect(dlRes.status).toBe(200)
      expect(dlRes.headers.get('content-type')).toBe('application/pdf')
      expect(await dlRes.text()).toBe('PDF-BYTES')
    }
    finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('__kay_action_err hydrates & clears on prerendered routes, and survives load() redirects and <Region> requests', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kay-flash-lifecycle-'))
    try {
      mkdirSync(join(dir, 'src/routes'), { recursive: true })
      mkdirSync(join(dir, 'src/actions'), { recursive: true })

      writeFileSync(join(dir, 'src/actions/contact.ts'), `
        import { action } from '@kayjs/kay/server'
        export const send = action(async (ctx) => ctx.deny(422, 'Contact failed'))
      `)
      writeFileSync(join(dir, 'src/routes/contact.tsx'), `
        import { getActionError } from '@kayjs/kay/server'
        import type { PageProps } from '@kayjs/kay/server'
        import { send } from '../actions/contact'
        export const prerender = true
        export default function Contact({ locals }: PageProps) {
          const err = getActionError(locals)
          return <main><h1>Contact</h1>{err && <p class="err">{err.error}</p>}<form action={send} method="post"><button>Send</button></form></main>
        }
      `)
      writeFileSync(join(dir, 'src/routes/about.tsx'), `
        export const prerender = true
        export default function About() { return <main><h1>About</h1></main> }
      `)
      writeFileSync(join(dir, 'src/routes/bounce.tsx'), `
        import type { RequestContext } from '@kayjs/kay/server'
        export function load(ctx: RequestContext) { return ctx.redirect('/target', 302) }
        export default function Bounce() { return <p>unreachable</p> }
      `)
      writeFileSync(join(dir, 'src/routes/target.tsx'), `
        import { Region } from '@kayjs/kay'
        import { getActionError } from '@kayjs/kay/server'
        import type { PageProps } from '@kayjs/kay/server'
        export default function Target({ locals }: PageProps) {
          const err = getActionError(locals)
          return (
            <main>
              <Region name="side"><aside>Sidebar</aside></Region>
              <p class="target-err">{err?.error ?? 'none'}</p>
            </main>
          )
        }
      `)

      const app = await testApp({ root: dir })
      const sendUrl = app.manifest!.actions.find(a => a.exportName === 'send')!.url
      const triggerFlash = async (referer: string) => {
        const res = await app.fetch(new Request(`http://localhost${sendUrl}`, {
          method: 'POST',
          headers: { accept: 'text/html', origin: 'http://localhost', referer },
        }))
        expect(res.status).toBe(303)
      }

      // 1. Prerendered page /contact displays flash error AND clears cookie so /target never sees a leaked error
      await triggerFlash('http://localhost/contact')
      const contactHtml = await (await app.get('/contact')).text()
      expect(contactHtml).toContain('<p class="err">Contact failed</p>')
      expect(await (await app.get('/target')).text()).toContain('<p class="target-err">none</p>')

      // 2. Visiting an unrelated prerendered page /about still clears __kay_action_err (no leak to later dynamic /target)
      await triggerFlash('http://localhost/about')
      const aboutRes = await app.get('/about')
      expect(aboutRes.status).toBe(200)
      expect(await (await app.get('/target')).text()).toContain('<p class="target-err">none</p>')

      // 3. load() redirect (/bounce -> /target) does NOT delete __kay_action_err before /target renders
      await triggerFlash('http://localhost/bounce')
      const bounceRes = await app.get('/bounce')
      expect(bounceRes.status).toBe(302)
      expect(bounceRes.headers.get('location')).toBe('/target')
      expect(bounceRes.headers.getSetCookie().some(c => c.startsWith('__kay_action_err='))).toBe(false)

      // 4. <Region> request to /target does NOT delete __kay_action_err either
      const regionRes = await app.get('/target', { 'x-kay-region': 'side' })
      expect(regionRes.status).toBe(200)
      expect(await regionRes.text()).toBe('<aside>Sidebar</aside>')
      expect(regionRes.headers.getSetCookie().some(c => c.startsWith('__kay_action_err='))).toBe(false)

      // 5. Full page GET /target finally consumes & clears __kay_action_err
      expect(await (await app.get('/target')).text()).toContain('<p class="target-err">Contact failed</p>')
      expect(await (await app.get('/target')).text()).toContain('<p class="target-err">none</p>')
    }
    finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
