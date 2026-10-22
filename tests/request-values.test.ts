import { existsSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import process from 'node:process'
import { describe, expect, it } from 'bun:test'
import { outputDir } from '../src/build/assets'
import { compileKay } from '../src/compiler'
import { loadContextValues, useContexts } from '../src/server/context-values'
import { routeMounts, scanRoutes } from '../src/server/routes'
import { kayCheck } from './check-helper'
import { loads } from './fixtures/request-values/lib/state'
import { fixtureCopy, scratchDir } from './scratch'
import { pages } from './shared-pages'

const FIXTURE = 'tests/fixtures/request-values'
const CONTEXT = resolve(`${FIXTURE}/lib/context.ts`)
const EXTENSION = { name: 'values', context: CONTEXT }
const I18N = { locales: ['en', 'fr'], defaultLocale: 'en' }

interface Variant { base: string, dev: boolean, locale: boolean }

const variants: Variant[] = [false, true].flatMap(dev => ['', '/repo'].flatMap(base => [false, true].map(locale => ({ dev, base, locale }))))
const apps = new Map<string, ReturnType<typeof pages>>()

// A request from a visitor named by headers, where the proxy in front of kay has stripped the base.
async function get(variant: Variant, path: string, headers: Record<string, string> = {}) {
  const key = JSON.stringify(variant)
  let held = apps.get(key)

  if (!held) {
    held = pages({ root: FIXTURE, extensions: [EXTENSION], prebuilt: false, security: false, inlineStyles: false, site: 'https://site.example', dev: variant.dev, base: variant.base || undefined, i18n: variant.locale ? I18N : undefined })
    apps.set(key, held)
  }

  loads.length = 0

  const response = await (await held).handle(new Request(`http://localhost${variant.locale ? '/fr' : ''}${path}`, { headers }))

  return { status: response.status, html: await response.text(), headers: response.headers, loads: [...loads] }
}

const ADA = { 'x-user': 'Ada', 'x-roles': 'admin' }
const BOB = { 'x-user': 'Bob' }

describe('a template reading ctx', () => {
  for (const variant of variants) {
    const label = `${variant.dev ? 'dev' : 'production'}, base ${variant.base || 'unset'}, ${variant.locale ? 'locale prefix' : 'no locale'}`

    it(`shows the user and the role check in the first bytes of a page reaching it, however deep, ${label}`, async () => {
      for (const path of ['/gated', '/deep']) {
        const admin = await get(variant, path, ADA)

        expect(admin.status).toBe(200)
        expect(admin.html).toContain('<p id="who">Ada</p>')
        expect(admin.html).toContain('<p id="admin">Admin</p>')
        expect(admin.html).toContain('id="inside"')
        expect(admin.html).not.toContain('kay-await')
        expect(admin.loads).toHaveLength(1)
        expect(admin.headers.get('cache-control')).toBe('private, no-cache')
        expect(admin.headers.get('vary')).toContain('cookie')

        const member = await get(variant, path, BOB)

        expect(member.html).toContain('<p id="who">Bob</p>')
        expect(member.html).not.toContain('id="admin"')

        const guest = await get(variant, path)

        expect(guest.html).not.toContain('id="who"')
        expect(guest.html).not.toContain('id="admin"')
      }
    })

    it(`reads it in a layout and in a page's own template, once per request, ${label}`, async () => {
      const inner = await get(variant, '/inner/page', ADA)

      expect(inner.html).toContain('<nav id="admin-nav">Admin menu</nav>')
      expect(inner.loads).toHaveLength(1)
      expect((await get(variant, '/inner/page', BOB)).html).not.toContain('admin-nav')
      expect((await get(variant, '/inline', ADA)).html).toContain('<p id="name">Ada</p>')
      expect((await get(variant, '/inline')).html).toContain('<p id="name">Guest</p>')

      const fenced = await get(variant, '/fenced', ADA)

      expect(fenced.html).toMatch(/<p id="path">[^<]*\/fenced<\/p>/)
      expect(fenced.html).toContain('<p id="name">Ada</p>')
    })

    it(`loads nothing and keeps a page reaching no template cacheable, ${label}`, async () => {
      const plain = await get(variant, '/plain', ADA)

      expect(plain.html).toContain('id="plain"')
      expect(plain.loads).toEqual([])
      expect(plain.headers.get('cache-control') ?? '').not.toContain('private')
    })
  }

  it('loads for a page reaching the template only through import.meta.glob', async () => {
    const page = await get({ base: '', dev: false, locale: false }, '/globbed', ADA)

    expect(page.html).toContain('<p id="who">Ada</p>')
    expect(page.loads).toHaveLength(1)
    expect(page.headers.get('cache-control')).toBe('private, no-cache')
  })

  it('is refused in a prerendered page, which holds no request', async () => {
    const request = new Request('http://localhost/gated')

    useContexts(request, [CONTEXT], true)
    await expect(loadContextValues(request)).rejects.toThrow('a prerendered page renders once')
  })

  it('is mounted only where an extension gives a context, around the pages reaching a template that reads it', async () => {
    const root = resolve(FIXTURE)
    const wrapped = async (extensions: { name: string, context?: string }[]) => (await scanRoutes(resolve(FIXTURE, 'src/routes'), routeMounts(root, extensions))).filter(route => route.layouts.some(layout => layout.includes('context-layout'))).map(route => route.pattern).sort()

    expect(await wrapped([EXTENSION])).toEqual(['/bare', '/deep', '/fenced', '/gated', '/globbed', '/inline', '/inner/page'])
    expect(await wrapped([{ name: 'none' }])).toEqual([])
  })

  it('is no island\'s to read, which renders in the browser too', () => {
    const messages = (source: string, insideIsland?: boolean) => compileKay(source, 'test.kay', { insideIsland }).diagnostics.map(d => d.message)
    const reactive = '---\nimport { signal } from "kay"\nconst count = signal(0)\n---\np {ctx.user?.name} {count()}\n'

    expect(messages(reactive)).toEqual([expect.stringContaining('`ctx` is read on the server')])
    expect(messages('p {ctx.user?.name}\n', true)).toEqual([expect.stringContaining('`ctx` is read on the server')])
    expect(messages('p {ctx.user?.name}\n')).toEqual([])
  })

  it('keeps a script\'s own ctx, and a fence\'s, as they are', () => {
    const own = compileKay('---\nconst ctx = { user: 1 }\n---\np {ctx.user}\n', 'test.kay')
    const fence = compileKay('--- server\nconst path = ctx.url.pathname\n---\np {path}\n', 'test.kay')

    for (const compiled of [own, fence]) {
      expect(compiled.diagnostics).toEqual([])
      expect(compiled.tsx).not.toContain('import { ctx }')
    }
  })

  it('loads for a page setting layouts: false that reaches one, and not for a local named ctx', async () => {
    const variant = { base: '', dev: false, locale: false }
    const bare = await get(variant, '/bare', ADA)

    expect(bare.html).toContain('<p id="who">Ada</p>')
    expect(bare.loads).toHaveLength(1)

    const shadowed = await get(variant, '/shadowed', ADA)

    expect(shadowed.html).toContain('<p id="local">7</p>')
    expect(shadowed.loads).toEqual([])
    expect(shadowed.headers.get('cache-control') ?? '').not.toContain('private')

    const source = '---\nimport { signal } from "kay"\nconst n = signal(0)\n---\n' + 'button(click={() => { const ctx = canvas.getContext("2d"); ctx?.fill(); n++ }}) Draw {n()}\n'

    expect(compileKay(source, 'test.kay').diagnostics).toEqual([])
  })

  it('refuses two extensions giving one key, and a load answering no object', async () => {
    const twice = new Request('http://localhost/twice')

    useContexts(twice, [CONTEXT, CONTEXT], false)
    await expect(loadContextValues(twice)).rejects.toThrow('two extensions give ctx.user')
  })

  it('tries a failed load again for the next layout asking, and loads once for concurrent callers', async () => {
    const dir = await scratchDir('request-values-retry-')
    const file = resolve(dir, 'flaky.ts')

    await Bun.write(file, 'import { defineContext } from \'kay/library\'\n\nlet calls = 0\n\nexport const count = () => calls\n\nexport default defineContext(async () => {\n  calls++\n  await Bun.sleep(5)\n\n  if (calls === 1)\n    throw new Error(\'store down\')\n\n  return { calls }\n})\n')
    const request = new Request('http://localhost/flaky')
    const { count } = await import(file) as { count: () => number }

    useContexts(request, [file], false)
    await expect(loadContextValues(request)).rejects.toThrow('store down')
    await Promise.all([loadContextValues(request), loadContextValues(request)])
    await loadContextValues(request)
    expect(count()).toBe(2)
  })

  it('types ctx from the extension in kay check', async () => {
    const root = await fixtureCopy('request-values')

    await Bun.write(resolve(root, 'kay.config.ts'), 'import { defineConfig } from \'kay/server\'\n\nexport default defineConfig({ extensions: [{ name: \'values\', context: \'./lib/context.ts\' }] })\n')
    await Bun.write(resolve(root, 'tsconfig.json'), await Bun.file('tests/fixtures/action-streams/tsconfig.json').text())
    await Bun.write(resolve(root, 'src/routes/typed.kay'), 'p#typed {ctx.user?.name}\n')
    await Bun.write(resolve(root, 'src/routes/untyped.kay'), 'p#untyped {ctx.nope}\n')

    const { output, report } = await kayCheck([root])
    const text = output + report

    expect(text).toContain('untyped.kay')
    expect(text).toContain('\'nope\'')
    expect(text).not.toContain('routes/typed.kay')
  })
})

describe('a production server started from disk', () => {
  // A process of its own, as the test process compiled `.kay` files already and Babel fills `require.cache` once loaded.
  async function run(script: string, failing = false): Promise<string> {
    const child = Bun.spawn([process.execPath, '-e', script], { stdout: 'pipe', stderr: 'pipe' })
    const [output, errors, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])

    expect({ code, errors: failing ? '' : errors }).toEqual({ code: 0, errors: '' })

    return output.trim()
  }

  // Where the build writes it, apart for each worker of a parallel run.
  const recordFile = (root: string) => join(outputDir(root), 'context-reads.json')

  async function project(extensions: { name: string, context?: string }[], base?: string): Promise<{ root: string, options: string }> {
    const root = resolve(await fixtureCopy('request-values'))
    const mapped = extensions.map(extension => extension.context === undefined ? extension : { ...extension, context: resolve(root, 'lib/context.ts') })

    return { root, options: JSON.stringify({ root, extensions: mapped, prebuilt: true, security: false, inlineStyles: false, site: 'https://site.example', ...base !== undefined && { base } }) }
  }

  async function build(options: string): Promise<void> {
    await run(`import { buildProject } from ${JSON.stringify(resolve('src/build/pipeline'))}\nconst options = ${options}\nconst built = await buildProject(options.root, { extensions: options.extensions, security: false, inlineStyles: false, site: options.site, base: options.base, i18n: options.i18n }, { check: false })\nif (built.failed) throw built.failed.error\n`)
  }

  // The status and body of a page of the server, as a proxy stripping the base forwards it, started from the build in `options`.
  async function get(options: string, path: string, failing = false): Promise<{ status: number, html: string }> {
    const script = `const options = ${options}\nconst { pages } = await import(${JSON.stringify(resolve('src/server'))})\nconst app = await pages(options)\nconst response = await app.handle(new Request('http://localhost${path}', { headers: { 'x-user': 'Ada', 'x-roles': 'admin' } }))\nconsole.log(JSON.stringify({ status: response.status, html: await response.text() }))\n`

    return JSON.parse(await run(script, failing)) as { status: number, html: string }
  }

  // The pages of the server started from the build in `options` in a process of its own, with the files of the compiler it loaded.
  async function boot(options: string, paths: string[], headers: Record<string, string> = { 'x-user': 'Ada', 'x-roles': 'admin' }, warned = false) {
    const script = `const options = ${options}\nconst { pages } = await import(${JSON.stringify(resolve('src/server'))})\nconst app = await pages(options)\nconst answers = []\nfor (const path of ${JSON.stringify(paths)}) {\n  const response = await app.handle(new Request('http://localhost' + path, { headers: ${JSON.stringify(headers)} }))\n  answers.push({ status: response.status, html: await response.text() })\n}\nconsole.log(JSON.stringify({ answers, loaded: Object.keys(require.cache).filter(key => key.includes('@babel/parser')).length }))\n`

    return JSON.parse(await run(script, warned)) as { answers: { status: number, html: string }[], loaded: number }
  }

  // The routes a scan finds and the packages of the compiler it loaded, with the record of the build or without.
  async function scan(root: string, options: string, recorded: boolean) {
    const script = `const { routeMounts, scanRoutes } = await import(${JSON.stringify(resolve('src/server/routes'))})\nconst { readContextRecord } = await import(${JSON.stringify(resolve('src/server/context-record'))})\nconst root = ${JSON.stringify(root)}\nconst record = ${recorded} ? await readContextRecord(${JSON.stringify(outputDir(root))}, root) : undefined\nconst routes = await scanRoutes(root + '/src/routes', routeMounts(root, (${options}).extensions), record)\nconst loaded = Object.keys(require.cache).filter(key => key.includes('@babel/parser') || key.includes('context-reads'))\nconsole.log(JSON.stringify({ routes: routes.map(route => [route.pattern, route.layouts]), loaded: loaded.length }))\n`

    return JSON.parse(await run(script)) as { routes: [string, string[]][], loaded: number }
  }

  for (const base of [undefined, '/repo']) {
    it(`serves a page reaching a template reading ctx from the build's record, base ${base ?? 'unset'}`, async () => {
      const { root, options } = await project([EXTENSION], base)

      await build(options)
      expect(await Bun.file(recordFile(root)).json()).toMatchObject({ reads: { 'lib/gate.kay': true, 'src/routes/plain.kay': false }, keys: { 'lib/gate.kay': ['can', 'user'] }, edges: { 'src/routes/globbed.kay': expect.arrayContaining(['src/parts/gate.kay']) } })
      expect(await get(options, '/gated')).toMatchObject({ status: 200, html: expect.stringContaining('<p id="who">Ada</p>') })
    }, 120_000)
  }

  it('scans the same routes from the record as from the templates, without loading the compiler', async () => {
    const { root, options } = await project([EXTENSION])

    await build(options)

    const recorded = await scan(root, options, true)
    const compiled = await scan(root, options, false)

    expect(recorded.routes).toEqual(compiled.routes)
    expect(recorded.routes.filter(([, layouts]) => layouts.some(layout => layout.includes('context-layout'))).map(([pattern]) => pattern).sort()).toEqual(['/bare', '/deep', '/fenced', '/gated', '/globbed', '/inline', '/inner/page'])
    expect(recorded.loaded).toBe(0)
    expect(compiled.loaded).toBeGreaterThan(0)
  }, 120_000)

  it('takes the record over the templates, and the templates when the build recorded none', async () => {
    const { root, options } = await project([EXTENSION])

    await build(options)

    const record = recordFile(root)
    const answers = await Bun.file(record).json() as { reads: Record<string, boolean> }

    await Bun.write(record, JSON.stringify({ ...answers, reads: { ...answers.reads, 'lib/gate.kay': false } }))
    expect((await get(options, '/gated', true)).status).toBe(500)
    await rm(record)
    expect(await get(options, '/gated')).toMatchObject({ status: 200, html: expect.stringContaining('<p id="who">Ada</p>') })
  }, 120_000)

  it('writes the same record when built again over the last, with no check', async () => {
    const { root, options } = await project([EXTENSION])
    const record = recordFile(root)

    await build(options)

    const first = await Bun.file(record).text()

    await build(options)
    expect(await Bun.file(record).text()).toBe(first)
  }, 120_000)

  it('refuses a record missing a file a route reaches, asking for a new build', async () => {
    const { root, options } = await project([EXTENSION])

    await build(options)

    const record = recordFile(root)
    const answers = await Bun.file(record).json() as { reads: Record<string, boolean> }

    delete answers.reads['lib/gate.kay']
    await Bun.write(record, JSON.stringify(answers))
    await expect(run(`const options = ${options}\nconst { pages } = await import(${JSON.stringify(resolve('src/server'))})\nawait pages(options)\n`, true)).rejects.toThrow()
  }, 120_000)

  for (const base of [undefined, '/repo']) {
    it(`boots without loading the compiler and serves every page, however it reaches its parts, base ${base ?? 'unset'}`, async () => {
      const { options } = await project([EXTENSION], base)

      await build(options)

      const { answers, loaded } = await boot(options, ['/gated', '/globbed', '/deep', '/plain', '/missing'])

      expect(answers.map(answer => answer.status)).toEqual([200, 200, 200, 200, 404])
      expect(answers[0]!.html).toContain('<p id="who">Ada</p>')
      expect(answers[1]!.html).toContain('id="inside"')
      expect(loaded).toBe(0)
    }, 120_000)
  }

  it('loads the compiler when the build recorded no modules', async () => {
    const { root, options } = await project([EXTENSION])

    await build(options)
    await rm(resolve(outputDir(root), 'server-modules.json'))

    const { answers, loaded } = await boot(options, ['/gated'])

    expect(answers[0]!.status).toBe(200)
    expect(loaded).toBeGreaterThan(0)
  }, 120_000)

  it('loads the modules through the loader when the record has another shape or names a file outside the build', async () => {
    const { root, options } = await project([EXTENSION])

    await build(options)

    const file = resolve(outputDir(root), 'server-modules.json')
    const record = await Bun.file(file).json() as { files: Record<string, { file: string }> }

    for (const found of Object.values(record.files))
      found.file = '../../../etc/passwd'

    await Bun.write(file, JSON.stringify(record))

    const { answers, loaded } = await boot(options, ['/gated'], undefined, true)

    expect(answers[0]!.status).toBe(200)
    expect(loaded).toBeGreaterThan(0)
  }, 120_000)

  it('serves a dynamic route and each locale of a page from the record', async () => {
    const { root, options } = await project([EXTENSION])

    await Bun.write(resolve(root, 'src/routes/[slug].kay'), '--- server\nconst slug: string = ctx.params.slug\n---\np#slug {slug}\n')

    const i18n = JSON.stringify({ ...JSON.parse(options), i18n: I18N })

    await build(i18n)

    const { answers, loaded } = await boot(i18n, ['/gated', '/fr/gated', '/fr/anything', '/anything'])

    expect(answers.map(answer => answer.status)).toEqual([200, 200, 200, 200])
    expect(answers[1]!.html).toContain('<p id="who">Ada</p>')
    expect(answers[2]!.html).toContain('<p id="slug">anything</p>')
    expect(loaded).toBe(0)
  }, 120_000)

  it('registers the actions of a page from the record, as the page imports them', async () => {
    const { root, options } = await project([EXTENSION])

    await Bun.write(resolve(root, 'src/routes/enter.kay'), '--- server\nimport { t } from \'elysia\'\nimport { action } from \'kay\'\n\nexport const enter = action(t.Object({ name: t.String() }), async (_input, ctx) => {\n  ctx.redirect(\'/plain\')\n})\n---\nform(method="post" action={enter.url})\n  input(name="name")\n  button Go\n')
    await build(options)

    const script = `const options = ${options}\nconst { pages } = await import(${JSON.stringify(resolve('src/server'))})\nconst app = await pages(options)\nconst page = await (await app.handle(new Request('http://localhost/enter'))).text()\nconst url = /action="([^"]+)"/.exec(page)[1]\nconst posted = await app.handle(new Request('http://localhost' + url, { method: 'POST', headers: { origin: 'http://localhost', 'content-type': 'application/x-www-form-urlencoded' }, body: 'name=Ada' }))\nconsole.log(JSON.stringify({ status: posted.status, location: posted.headers.get('location'), loaded: Object.keys(require.cache).filter(key => key.includes('@babel/parser')).length }))\n`

    expect(JSON.parse(await run(script))).toEqual({ status: 303, location: '/plain', loaded: 0 })
  }, 120_000)

  it('maps the stack of an error in a recorded component to its .kay lines', async () => {
    const { root, options } = await project([EXTENSION])

    await Bun.write(resolve(root, 'src/shared/boom.kay'), '--- module\nexport function explode(): never {\n  throw new Error(\'Boom\')\n}\n---\np boom\n')
    await Bun.write(resolve(root, 'src/routes/lazy.kay'), '---\nconst load = () => import(\'../shared/boom.kay\')\n---\np {String(load)}\n')
    await build(options)

    const script = `const options = ${options}\nconst { pages } = await import(${JSON.stringify(resolve('src/server'))})\nawait pages(options)\nconst { describeThrown } = await import(${JSON.stringify(resolve('src/build/sourcemap'))})\nlet text = ''\ntry {\n  const { explode } = await import(${JSON.stringify(resolve(root, 'src/shared/boom.kay'))})\n  explode()\n}\ncatch (error) {\n  text = describeThrown(error)\n}\nconsole.log(JSON.stringify(text))\n`

    expect(JSON.parse(await run(script)) as string).toContain('boom.kay:3:')
  }, 120_000)

  it('boots from the build in another directory than the one it was made in', async () => {
    const { root, options } = await project([EXTENSION])

    await build(options)

    // A directory whose name holds what a pattern reads, which the loader's filters match paths against.
    const moved = resolve(await scratchDir('request-values-moved (odd) $x+[a]-'))

    await Bun.spawn(['cp', '-a', `${root}/.`, moved]).exited

    const { answers, loaded } = await boot(options.replaceAll(root, moved), ['/gated', '/globbed'])

    expect(answers.map(answer => answer.status)).toEqual([200, 200])
    expect(answers[1]!.html).toContain('id="inside"')
    expect(loaded).toBe(0)
  }, 120_000)

  it('compiles a component edited since the build, and keeps loading the others from the record', async () => {
    const { root, options } = await project([EXTENSION])

    await build(options)
    await Bun.write(resolve(root, 'lib/gate.kay'), `${await Bun.file(resolve(root, 'lib/gate.kay')).text()}p#edited Edited\n`)

    const { answers } = await boot(options, ['/gated', '/globbed'])

    expect(answers[0]!.html).toContain('<p id="edited">Edited</p>')
    expect(answers[1]!.html).toContain('id="inside"')
  }, 120_000)

  it('writes no record without a context', async () => {
    const { root, options } = await project([{ name: 'none' }])

    await build(options)
    expect(existsSync(recordFile(root))).toBe(false)
    expect(await get(options, '/plain')).toMatchObject({ status: 200 })
  }, 120_000)
})
