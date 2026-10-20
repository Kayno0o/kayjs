import { readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import process from 'node:process'
import { afterAll, describe, expect, it } from 'bun:test'
import { gzipSize } from '../src/build/report'
import { scratchDir } from './scratch'

const CLI = join(import.meta.dir, '../src/cli.ts')
const FIXTURES = join(import.meta.dir, 'fixtures')
const TSCONFIG = JSON.stringify({
  compilerOptions: { target: 'ESNext', jsx: 'preserve', jsxImportSource: 'kay', lib: ['ESNext', 'DOM'], rootDirs: ['.', '.kay/types'], module: 'Preserve', moduleResolution: 'bundler', strict: true, noEmit: true, skipLibCheck: true },
  include: ['src', '.kay/types'],
})
const roots: string[] = []

interface Footprint {
  weight: number
  parts: { html: number, css: number, js: number, images: number, fonts: number }
  requests: number
  dom: number
  unweighed: number
  score: number
  grade: string
  co2: number
}

interface Result {
  code: number
  out: string
  err: string
  document: { problems: { code: string, message: string, note?: string, severity?: string }[], built?: { footprints: { route: string, pages: number, path?: string, footprint?: Footprint }[] } }
}

const HOME = `---
import { image } from 'kay/image'
import hero from '../hero.png'
---
h1 Home
img({...image(hero, { sizes: '(min-width: 60rem) 50vw, 100vw' })} alt="Hero" loading="eager")
img({...image(hero, { sizes: '100vw' })} alt="Below the fold" loading="lazy")
`

// An app with a hero image shown twice, a preloaded font, a route with listed params, one with unlisted params and an island.
async function project(config: string, extra: Record<string, string | Uint8Array> = {}, without: string[] = []): Promise<string> {
  const root = await scratchDir('footprint-build-')
  const files: Record<string, string | Uint8Array> = {
    'tsconfig.json': TSCONFIG,
    'kay.config.ts': `import { defineConfig } from 'kay/server'\n\nexport default defineConfig({ log: false, fonts: [{ family: 'Display', src: './src/display.woff2', preload: true }], ${config} })\n`,
    'src/hero.png': await Bun.file(join(FIXTURES, 'images/src/hero.png')).bytes(),
    'src/display.woff2': await Bun.file(join(FIXTURES, 'seo/src/fonts/display.woff2')).bytes(),
    'src/messages/en.ts': 'import { defineMessages } from \'kay/i18n\'\n\nexport default defineMessages({ hello: \'Hello\' })\n',
    'src/messages/fr.ts': 'import { defineMessages } from \'kay/i18n\'\n\nexport default defineMessages({ hello: \'Bonjour\' })\n',
    'src/routes/index.kay': HOME,
    'src/routes/plain.kay': 'p Plain\n',
    'src/routes/post/[slug].kay': '--- server\nexport const page = { prerender: () => [{ slug: \'a\' }, { slug: \'b\' }] }\n\nconst { slug } = ctx.params\n---\nh1 {slug}\n',
    'src/routes/req/[id].kay': '--- server\nconst { id } = ctx.params\n---\nh1 {id}\n',
    'src/routes/heavy.kay': '---\nconst rows = Array.from({ length: 2400 }, (_, index) => index)\n---\nfor row of rows\n  p {row}\n',
    ...extra,
  }

  for (const name of without)
    delete files[name]

  roots.push(root)
  await Promise.all(Object.entries(files).map(async ([path, content]) => Bun.write(join(root, path), content)))

  return root
}

async function built(root: string, ...args: string[]): Promise<Result> {
  const json = !args.includes('--text')
  const child = Bun.spawn([process.execPath, CLI, 'build', root, '--no-check', ...json ? ['--format', 'json'] : [], ...args.filter(arg => arg !== '--text')], { stdout: 'pipe', stderr: 'pipe', env: { ...process.env, NODE_ENV: 'production' } })
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])

  return { code, out, err, document: json ? JSON.parse(out) : { problems: [] } }
}

const sizeOf = async (path: string) => Bun.file(path).size
const footprintOf = (result: Result, route: string) => result.document.built!.footprints.find(each => each.route === route)

async function variant(root: string, width: number, extension: 'avif' | 'webp'): Promise<string> {
  const dir = join(root, '.kay/client/dist/images')
  const name = (await readdir(dir)).find(file => file.startsWith('hero-') && file.endsWith(`-${width}.${extension}`))

  return join(dir, name!)
}

afterAll(async () => {
  await Promise.all(roots.map(async root => rm(root, { recursive: true, force: true })))
})

describe('kay build footprints', () => {
  it('weighs a page whole: the HTML written, the AVIF variants the srcset picks at 1280 px, lazy ones included, and the preloaded font', async () => {
    const root = await project('')
    const result = await built(root)
    const home = footprintOf(result, '/')!.footprint!
    const html = await Bun.file(join(root, '.kay/client/pages/index.html')).bytes()
    const tags = new TextDecoder().decode(html).match(/<[a-z][^\s>/]*/gi)!
    const font = (await readdir(join(root, '.kay/client/dist/assets'))).find(file => file.endsWith('.woff2'))!

    expect(result.document.problems).toEqual([])
    expect(home.parts).toEqual({
      html: gzipSize(html),
      css: 0,
      js: 0,
      // 50vw of 1280 is 640; the lazy one takes the whole window, which only the 1000 wide variant fills.
      images: await sizeOf(await variant(root, 640, 'avif')) + await sizeOf(await variant(root, 1000, 'avif')),
      fonts: await sizeOf(join(root, '.kay/client/dist/assets', font)),
    })
    // The document, the two images and the font.
    expect(home.requests).toBe(4)
    expect(home.dom).toBe(tags.length)
    expect(home.unweighed).toBe(0)
    expect(home.weight).toBe(Object.values(home.parts).reduce((sum, each) => sum + each, 0))
    expect(footprintOf(result, '/plain')!.footprint!.parts.images).toBe(0)
  }, 120_000)

  it('counts the scripts and stylesheets a page links as the route table does, and not the chunks an island loads later', async () => {
    const root = await project('', {
      'src/counter.kay': '---\nimport { signal } from \'kay\'\n\nconst n = signal(0)\n---\nbutton(type="button" onClick={() => n.set(n() + 1)}) {n()}\n',
      'src/routes/counter.kay': '---\nimport Counter from \'../counter.kay\'\nimport \'../note.css\'\n---\np.note Counted\nCounter\n',
      'src/note.css': `.note { color: rebeccapurple; margin: 0 auto; padding: 1rem 2rem; border: 1px solid #123456 }\n${'.row { margin: 1px 2px 3px 4px }\n'.repeat(400)}`,
    })
    const result = await built(root)
    const counter = footprintOf(result, '/counter')!.footprint!
    const route = (result.document.built as unknown as { routes: { route: string, js: number, css: number }[] }).routes.find(each => each.route === '/counter')!
    const page = await Bun.file(join(root, '.kay/client/pages/counter.html')).text()

    expect(counter.parts.js).toBe(route.js)
    expect(counter.parts.js).toBeGreaterThan(5000)
    expect(page).toContain('modulepreload')
    // The stylesheet is inlined or linked, and counted once either way.
    expect(counter.parts.css + counter.parts.html).toBeGreaterThan(route.css)
    // The document and each script, stylesheet and font the page names, once.
    expect(counter.requests).toBe(1 + new Set([...page.matchAll(/(?:src|href)="([^"]+\.(?:js|css|woff2))"/g)].map(match => match[1])).size)
  }, 120_000)

  it('measures a route with params on the pages the build has, and says one with none is not measured', async () => {
    const result = await built(await project(''))
    const post = footprintOf(result, '/post/:slug')!

    expect(post.pages).toBe(2)
    expect(['/post/a', '/post/b']).toContain(post.path!)
    expect(post.footprint!.weight).toBeGreaterThan(0)
    expect(footprintOf(result, '/req/:id')).toEqual({ route: '/req/:id', pages: 0 })

    const text = await built(await project(''), '--text')

    expect(text.out).toContain('Pages as a browser loads them')
    expect(text.out).toMatch(/\/req\/:id +not measured: no page of it was prerendered/)
    expect(text.out).toMatch(/\/post\/:slug +[\d.]+ (?:B|KB) +2 +\d+ +A \(\d+\) +0\.\d+\n +html .*; heaviest of 2 pages, \/post\/[ab]/)
    // The tables that were there stay.
    expect(text.out).toContain('Routes, gzip (~: scripts it can load, no page rendered at build):')
    expect(text.out).toContain('Stages (the check and the bundle run side by side):')
    expect(text.out).toMatch(/page footprints +\d+ ms/)
  }, 120_000)

  it('weighs the same under a base path and with locales, a page of each locale counting', async () => {
    const plain = footprintOf(await built(await project('')), '/')!.footprint!
    const root = await project('base: \'/docs\', trailingSlash: \'always\', i18n: { locales: [\'fr\', \'en\'], defaultLocale: \'fr\' }')
    const result = await built(root)
    const home = footprintOf(result, '/')!

    expect(result.document.problems).toEqual([])
    expect(home.pages).toBe(2)
    expect(home.footprint!.unweighed).toBe(0)
    expect(home.footprint!.parts.images).toBe(plain.parts.images)
    expect(home.footprint!.parts.fonts).toBe(plain.parts.fonts)
    expect(home.footprint!.requests).toBe(4)
  }, 240_000)

  it('weighs a static export with WebP, as a static host cannot pick a format', async () => {
    const root = await project('', {}, ['src/routes/req/[id].kay'])
    const result = await built(root, '--static', '--outdir', join(root, 'out'))
    const home = footprintOf(result, '/')!.footprint!

    expect(result.code).toBe(0)
    expect(home.parts.images).toBe(await sizeOf(await variant(root, 640, 'webp')) + await sizeOf(await variant(root, 1000, 'webp')))
    expect(home.unweighed).toBe(0)
  }, 120_000)

  it('warns of a page over a weight or grade budget, naming what it weighs', async () => {
    const warned = await built(await project('budget: { weight: \'1kb\', grade: \'C\' }'))
    const over = warned.document.problems.filter(problem => problem.code === 'over-budget')

    expect(warned.code).toBe(0)
    expect(over.every(problem => problem.severity === 'warning')).toBe(true)
    const messages = over.map(problem => problem.message.replace(/ [\d.]+ (?:B|KB|MB) whole/, ' N whole').replace(/grade \w \(\d+\)/, 'grade X')).sort()

    expect(messages).toEqual([
      '`/heavy` has EcoIndex grade X, worse than the budget of C',
      '`/heavy` weighs N whole, over the budget of 1.0 KB',
      '`/` weighs N whole, over the budget of 1.0 KB',
    ].sort())
    // A page under the budget is not reported, nor one nothing measured.
    expect(messages.join('\n')).not.toContain('/plain')
    expect(messages.join('\n')).not.toContain('/req')
    expect(over.find(problem => problem.message.includes('grade'))!.note).toMatch(/^the page: 24\d\d DOM elements, \d+ requests, [\d.]+ KB$/)
  }, 240_000)

  it('lets lints deny the weight budget, and refuses a grade that is none', async () => {
    const denied = await built(await project('budget: { weight: \'1kb\' }, lints: { \'over-budget\': \'deny\' }'))

    expect(denied.code).toBe(1)
    expect(denied.document.problems.filter(problem => problem.code === 'over-budget' && problem.severity === 'error').length).toBeGreaterThan(0)

    const bad = await built(await project('budget: { grade: \'H\' as never }, lints: { \'over-budget\': \'allow\' }'))

    expect(bad.code).toBe(1)
    expect(bad.document.problems.map(problem => problem.message).join('\n')).toContain('`budget.grade` is "H"')
  }, 240_000)
})
