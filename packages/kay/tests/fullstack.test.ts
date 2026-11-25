import { afterAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build } from '../src/build/index'
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
import type { StandardSchemaV1 } from 'kay/server'

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
import { Head, type KayChild } from 'kay'

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
import type { Middleware } from 'kay/server'

const middleware: Middleware = async (ctx, next) => {
  ctx.locals.requestTag = 'from-root-mw'
  const res = await next()
  res.headers.set('x-root-mw', '1')
  return res
}
export default middleware
`)

writeFixture('src/routes/index.tsx', `
import { Head } from 'kay'

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
import { Head } from 'kay'

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
import type { KayChild } from 'kay'

export default function AdminLayout({ children }: { children?: KayChild }) {
  return <section class="admin-layout">{children}</section>
}
`)

writeFixture('src/routes/admin/_middleware.ts', `
import type { Middleware } from 'kay/server'

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
import { Suspense } from 'kay'

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
import type { RequestContext } from 'kay/server'

export function GET(ctx: RequestContext) {
  return ctx.json({ pong: true, tag: ctx.locals.requestTag })
}

export function POST(ctx: RequestContext) {
  ctx.cookies.set('session', 'valid-token')
  return ctx.json({ signedIn: true })
}
`)

writeFixture('src/actions/notes.ts', `
import { action } from 'kay/server'
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
import { signal } from 'kay'
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
import type { Middleware } from 'kay/server'

const reportsMiddleware: Middleware = async (ctx, next) => {
  ctx.locals.chain = [ctx.locals.requestTag, ctx.locals.role].join('>')
  return next()
}
export default reportsMiddleware
`)

writeFixture('src/routes/admin/reports/index.tsx', `
import { action } from 'kay/server'

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
    const app = await testApp({ root: fixtureDir })

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
import { resolveKaySpecifier } from 'kay/build'

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
