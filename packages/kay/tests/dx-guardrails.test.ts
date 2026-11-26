import { afterAll, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { tailwind } from '../../plugin-tailwind/src/index'
import { build } from '../src/build/index'
import { checkProject } from '../src/cli/check'
import { parseIslandProps } from '../src/dom/island'
import { ssrIsland } from '../src/ssr/index'
import { testApp } from '../src/test/index'

const tempDirs: string[] = []
function makeTemp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

afterAll(() => {
  for (const d of tempDirs)
    rmSync(d, { recursive: true, force: true })
})

describe('DX Guardrails, Rich Island Props, Progressive Form Errors & Tailwind Auto-Load (#3521)', () => {
  it('catches server-only imports in islands, non-serializable island props, route conflicts, and missing paths()', async () => {
    const dir = makeTemp('kay-check-guardrails-')
    mkdirSync(join(dir, 'src/components'), { recursive: true })
    mkdirSync(join(dir, 'src/routes/posts'), { recursive: true })

    // 1. Interactive island importing server-only bun:sqlite
    writeFileSync(join(dir, 'src/components/BadIsland.tsx'), `
      import { Database } from 'bun:sqlite'
      import { signal } from '@kayjs/kay'
      export function BadIsland({ format, createdAt, client }: { format?: (x: number) => string, createdAt?: Date, client?: unknown }) {
        const n = signal(0)
        void Database
        void format
        void createdAt
        void client
        return <button type="button" onClick={() => n.value++}>{n.value}</button>
      }
    `)

    // 2. Server page passing arrow function + unsupported class instance (but Date is allowed!)
    writeFileSync(join(dir, 'src/routes/index.tsx'), `
      import { BadIsland } from '../components/BadIsland'
      class CustomClient {}
      export default async function Home() {
        return <BadIsland format={(x: number) => String(x)} createdAt={new Date()} client={new CustomClient()} />
      }
    `)

    // 3. Conflicting dynamic routes ([id].tsx and [slug].tsx) + dynamic prerender missing paths()
    writeFileSync(join(dir, 'src/routes/posts/[id].tsx'), `
      export const prerender = true
      export default function PostById() { return <p>id</p> }
    `)
    writeFileSync(join(dir, 'src/routes/posts/[slug].tsx'), `
      export default function PostBySlug() { return <p>slug</p> }
    `)

    const res = await checkProject(dir, { skipTypecheck: true })
    expect(res.ok).toBe(false)
    expect(res.errors.some(e => e.includes('server-only module "bun:sqlite"'))).toBe(true)
    expect(res.errors.some(e => e.includes('function prop "format"') && e.includes('<BadIsland>'))).toBe(true)
    expect(res.errors.some(e => e.includes('new CustomClient()') && e.includes('prop "client"'))).toBe(true)
    expect(res.errors.some(e => e.includes('createdAt'))).toBe(false) // Date IS serializable!
    expect(res.errors.some(e => e.includes('conflicting routes') && e.includes('/posts/:'))).toBe(true)
    expect(res.errors.some(e => e.includes('without exporting `paths()`'))).toBe(true)
  })

  it('catches a local function passed by name from server code into an island (#3603)', async () => {
    const dir = makeTemp('kay-check-named-fn-')
    mkdirSync(join(dir, 'src/components'), { recursive: true })
    mkdirSync(join(dir, 'src/routes'), { recursive: true })
    writeFileSync(join(dir, 'src/components/Saver.tsx'), `
      import { signal } from '@kayjs/kay'
      export function Saver({ onSave, label }: { onSave?: () => void, label?: string }) {
        const n = signal(0)
        return <button type="button" onClick={() => { n.value++; onSave?.() }}>{label}</button>
      }
    `)
    writeFileSync(join(dir, 'src/routes/index.tsx'), `
      import { Saver } from '../components/Saver'
      function save(): void {}
      const title = 'Save'
      export default function Home() {
        const reset = () => {}
        return <main><Saver onSave={save} label={title} /><Saver onSave={reset} /></main>
      }
    `)

    const res = await checkProject(dir, { skipTypecheck: true })
    expect(res.errors.filter(e => e.includes('<Saver>')).map(e => /function prop "(\w+)"/.exec(e)?.[1])).toEqual(['onSave', 'onSave'])
    expect(res.errors.some(e => e.includes('"label"'))).toBe(false)
  })

  it('kay check follows an island into a workspace package the way the build does', async () => {
    const dir = makeTemp('kay-island-package-')
    mkdirSync(join(dir, 'src/routes'), { recursive: true })
    mkdirSync(join(dir, 'packages/shared-db'), { recursive: true })
    mkdirSync(join(dir, 'node_modules'), { recursive: true })
    writeFileSync(join(dir, 'packages/shared-db/package.json'), JSON.stringify({ name: 'shared-db', main: 'index.ts' }))
    writeFileSync(join(dir, 'packages/shared-db/index.ts'), `import { Database } from 'bun:sqlite'\nexport const open = () => new Database(':memory:')`)
    symlinkSync(join(dir, 'packages/shared-db'), join(dir, 'node_modules/shared-db'), 'dir')
    writeFileSync(join(dir, 'src/routes/index.tsx'), `
      import { signal } from '@kayjs/kay'
      import { open } from 'shared-db'
      export default function Home() { const n = signal(0); return <button type="button" onClick={() => { open(); n.value++ }}>{n.value}</button> }
    `)
    const checked = await checkProject(dir, { skipTypecheck: true })
    expect(checked.errors).toContain('packages/shared-db/index.ts:1:1: error: kay check: imports server-only module "bun:sqlite" and is reachable from the island in src/routes/index.tsx. Move server logic to a server action or async server component.')
    await expect(build({ root: dir, outDir: '.pkg' })).rejects.toThrow('packages/shared-db/index.ts imports server-only module "bun:sqlite"')
  })

  it('fails the build and kay check when an island reaches a server-only module or a private env var through a helper', async () => {
    const dir = makeTemp('kay-island-leak-')
    mkdirSync(join(dir, 'src/routes'), { recursive: true })
    mkdirSync(join(dir, 'src/lib'), { recursive: true })
    writeFileSync(join(dir, 'src/lib/db.ts'), `
      import { Database } from 'bun:sqlite'
      // process.env in a comment is not a read
      export const db = () => new Database(process.env.DATABASE_URL)
    `)
    writeFileSync(join(dir, 'src/lib/format.ts'), `
      import { db } from './db'
      export const label = (n: number) => db ? \`#\${n}\` : ''
    `)
    writeFileSync(join(dir, 'src/routes/index.tsx'), `
      import { signal } from '@kayjs/kay'
      import { label } from '../lib/format'
      function Counter() {
        const n = signal(0)
        return <button type="button" onClick={() => n.value++}>{label(n.value)}</button>
      }
      export async function load() { return { db: process.env.DATABASE_URL } }
      export default function Home() { return <Counter /> }
    `)

    const checked = await checkProject(dir, { skipTypecheck: true })
    expect(checked.errors.filter(e => e.includes('src/lib/db.ts'))).toEqual([
      'src/lib/db.ts:2:7: error: kay check: imports server-only module "bun:sqlite" and is reachable from the island in src/routes/index.tsx. Move server logic to a server action or async server component.',
      'src/lib/db.ts:4:44: error: kay check: reads process.env and is reachable from the island in src/routes/index.tsx. Only process.env.PUBLIC_* reaches the browser.',
    ])
    await expect(build({ root: dir, outDir: '.leak' })).rejects.toThrow('src/lib/db.ts imports server-only module "bun:sqlite"')

    writeFileSync(join(dir, 'src/lib/format.ts'), `
      export const label = (n: number) => \`\${process.env.API_KEY}\${n}\`
    `)
    await expect(build({ root: dir, outDir: '.env' })).rejects.toThrow('src/lib/format.ts reads process.env')

    writeFileSync(join(dir, 'src/lib/format.ts'), `
      export const label = (n: number) => \`\${process.env.PUBLIC_PREFIX}\${n}\`
    `)
    process.env.PUBLIC_PREFIX = 'item-'
    try {
      expect((await checkProject(dir, { skipTypecheck: true })).errors).toEqual([])
      await build({ root: dir, outDir: '.public', prerender: false })
      const js = readdirSync(join(dir, '.public/client')).filter(f => f.endsWith('.js')).map(f => readFileSync(join(dir, '.public/client', f), 'utf8')).join('')
      expect(js).toContain('item-')
      expect(js).not.toContain('process.env')
    }
    finally {
      delete process.env.PUBLIC_PREFIX
    }
  })

  it('round-trips Date, Set, Map, URL, RegExp, and BigInt across ssrIsland -> parseIslandProps', () => {
    const date = new Date('2026-11-24T12:34:56.000Z')
    const html = ssrIsland('/_kay/demo.js', () => '<div/>', {
      at: date,
      tags: new Set(['fast', 'small']),
      counts: new Map([['a', 1], ['b', 2]]),
      site: new URL('https://kayjs.kaynooo.fr/docs'),
      pattern: /^kay-\d+$/i,
      big: 9007199254740993n,
      plain: { ok: true, n: 42 },
    })

    const m = /p="([^"]+)"/.exec(html)
    expect(m).not.toBeNull()
    const unescaped = m![1]!.replaceAll('&quot;', '"').replaceAll('&amp;', '&').replaceAll('&lt;', '<').replaceAll('&gt;', '>')
    const parsed = parseIslandProps(unescaped)

    expect(parsed.at).toBeInstanceOf(Date)
    expect((parsed.at as Date).toISOString()).toBe('2026-11-24T12:34:56.000Z')
    expect(parsed.tags).toBeInstanceOf(Set)
    expect([...(parsed.tags as Set<string>)]).toEqual(['fast', 'small'])
    expect(parsed.counts).toBeInstanceOf(Map)
    expect((parsed.counts as Map<string, number>).get('b')).toBe(2)
    expect(parsed.site).toBeInstanceOf(URL)
    expect((parsed.site as URL).href).toBe('https://kayjs.kaynooo.fr/docs')
    expect(parsed.pattern).toBeInstanceOf(RegExp)
    expect((parsed.pattern as RegExp).test('KAY-99')).toBe(true)
    expect(parsed.big).toBe(9007199254740993n)
    expect(parsed.plain).toEqual({ ok: true, n: 42 })
  })

  it('flashes validation errors + safe values on progressive HTML <form> submit and clears after one GET', async () => {
    const dir = makeTemp('kay-prog-form-')
    mkdirSync(join(dir, 'src/actions'), { recursive: true })
    mkdirSync(join(dir, 'src/routes'), { recursive: true })

    writeFileSync(join(dir, 'src/actions/signup.ts'), `
      import { action } from '@kayjs/kay/server'
      const schema = {
        '~standard': {
          version: 1 as const,
          vendor: 'test',
          validate(raw: unknown) {
            const o = (raw ?? {}) as Record<string, unknown>
            const email = String(o.email ?? '')
            const password = String(o.password ?? '')
            if (!email.includes('@'))
              return { issues: [{ message: 'Invalid email', path: ['email'] }] }
            return { value: { email, password } }
          },
        },
      }
      export const signup = action(schema, async (input) => ({ email: input.email }))
    `)

    writeFileSync(join(dir, 'src/routes/index.tsx'), `
      import { getActionError } from '@kayjs/kay/server'
      import { signup } from '../actions/signup'
      export default function Page({ locals }: { locals: Record<string, unknown> }) {
        const err = getActionError(locals)
        return (
          <main>
            {err?.fieldErrors?.email && <p class="err">{err.fieldErrors.email}</p>}
            {err?.values?.email && <p class="prev-email">{err.values.email}</p>}
            {err?.values?.password && <p class="leaked-pw">{err.values.password}</p>}
            <form action={signup} method="post">
              <input name="email" />
              <input name="password" type="password" />
            </form>
          </main>
        )
      }
    `)

    const app = await testApp({ root: dir })
    const formPage = await (await app.get('/')).text()
    const actionUrl = /action="([^"]+)"/.exec(formPage)![1]!

    // 1. Progressive HTML form POST with invalid email + Referer -> 303 redirect + flash cookie (never echoing password!)
    const body = new URLSearchParams({ email: 'not-an-email', password: 'super-secret-value' })
    const postRes = await app.fetch(new Request(`http://localhost${actionUrl}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'accept': 'text/html',
        'origin': 'http://localhost',
        'referer': 'http://localhost/',
      },
      body: body.toString(),
    }))
    expect(postRes.status).toBe(303)
    expect(postRes.headers.get('location')).toBe('http://localhost/')

    // 2. Following redirect to GET / shows field error + safe email value, never password
    const afterRes = await app.get('/')
    const afterHtml = await afterRes.text()
    expect(afterHtml).toContain('<p class="err">Invalid email</p>')
    expect(afterHtml).toContain('<p class="prev-email">not-an-email</p>')
    expect(afterHtml).not.toContain('super-secret-value')
    expect(afterHtml).not.toContain('leaked-pw')

    // 3. Subsequent refresh GET / clears the one-shot flash cookie
    const secondHtml = await (await app.get('/')).text()
    expect(secondHtml).not.toContain('<p class="err">')

    // 4. JSON RPC call still returns 400 JSON directly
    const jsonRes = await app.post(actionUrl, { email: 'bad', password: 'pw' })
    expect(jsonRes.status).toBe(400)
    const jsonBody = await jsonRes.json() as { ok: boolean, fieldErrors?: Record<string, string> }
    expect(jsonBody.ok).toBe(false)
    expect(jsonBody.fieldErrors?.email).toBe('Invalid email')
  })

  it('auto-resolves bun-plugin-tailwind inside @kayjs/tailwind when bunPlugin is omitted', () => {
    const dir = makeTemp('kay-tw-auto-')
    mkdirSync(join(dir, 'node_modules/bun-plugin-tailwind'), { recursive: true })
    writeFileSync(join(dir, 'package.json'), '{"name":"tw-app","private":true}')
    writeFileSync(join(dir, 'node_modules/bun-plugin-tailwind/package.json'), '{"name":"bun-plugin-tailwind","main":"index.js"}')
    writeFileSync(join(dir, 'node_modules/bun-plugin-tailwind/index.js'), 'module.exports = { name: "mock-tw", setup() {} };')

    const plugin = tailwind({ css: 'src/app.css' })
    expect(typeof plugin.bunPlugins).toBe('function')
    const resolved = (plugin.bunPlugins as (info: { root: string, assetPrefix: string, minify: boolean }) => unknown[])({
      root: dir,
      assetPrefix: '/_kay',
      minify: true,
    })
    expect(resolved.length).toBe(1)
    expect((resolved[0] as { name: string }).name).toBe('mock-tw')
  })
})

describe('kay is imported as @kayjs/kay (#3578)', () => {
  it('fails the build on the bare kay spelling, naming the file and the scoped one', async () => {
    const dir = makeTemp('kay-bare-import-')
    mkdirSync(join(dir, 'src/routes'), { recursive: true })
    writeFileSync(join(dir, 'src/routes/index.tsx'), `
      import { signal } from 'kay/server'
      void signal
      export default function Home() { return <p>home</p> }
    `)
    const message = `kay compiler: import from 'kay/server' in src/routes/index.tsx: write '@kayjs/kay/server' (kay upgrade rewrites every import).`
    await expect(build({ root: dir, prerender: false })).rejects.toThrow(message)
    expect((await checkProject(dir, { skipTypecheck: true })).errors).toContain(`src/routes/index.tsx:2:30: error: ${message}`)
  })
})
