import { readdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import process from 'node:process'
import { describe, expect, it } from 'bun:test'
import { t } from 'elysia'
import { bootProblems } from '../src/check/boot'
import { ServedPaths } from '../src/server/served-paths'
import { scratchDir } from './scratch'
import { pages } from './shared-pages'

const CLI = resolve('src/cli.ts')

describe('served paths', () => {
  it('stops the boot when two claims share a path, and lets kay\'s own files give way', () => {
    const served = new ServedPaths()

    served.claim({ path: '/about', owner: 'about.kay', kind: 'page' })
    expect(() => served.claim({ path: '/about', owner: 'public/about', kind: 'public' })).toThrow('kay: about.kay and public/about both serve /about')
    expect(() => served.claim({ path: '/about', owner: 'x', kind: 'public' }, taken => `kay: ${taken.owner} again`)).toThrow('kay: about.kay again')
    // Another method, or params named apart, are told apart by the router alone.
    served.claim({ path: '/about', owner: 'about.ts', kind: 'api', method: 'POST' })
    expect(() => served.claim({ path: '/about', owner: 'all.ts', kind: 'api', method: 'ALL' })).toThrow('both serve /about')
    served.claim({ path: '/items/:id', owner: 'items/[id=integer].kay', kind: 'page', fallsThrough: true })
    served.claim({ path: '/items/:slug', owner: 'items/[slug].kay', kind: 'page' })
    expect(() => served.claim({ path: '/items/:other', owner: 'items/[other].kay', kind: 'page' })).toThrow('items/[slug].kay and items/[other].kay both serve')
    served.claim({ path: '/feeds/:slug', owner: '[slug].json.ts', kind: 'endpoint', suffix: '.json' })
    served.claim({ path: '/feeds/:slug', owner: '[slug].xml.ts', kind: 'endpoint', suffix: '.xml' })

    expect(served.offer({ path: '/about', owner: 'the favicon', kind: 'kay' })).toBe(false)
    expect(served.offer({ path: '/favicon.ico', owner: 'the favicon', kind: 'kay' })).toBe(true)
    expect(served.offer({ path: '/favicon.ico', owner: 'the favicon', kind: 'kay' })).toBe(false)
  })

  it('gives what was only offered to a claim coming after it, and refuses that claim where anything else holds the path', () => {
    const served = new ServedPaths()
    const alias = { path: '/old', owner: 'public/old.html', kind: 'public' as const }

    expect(served.offer(alias)).toBe(true)
    served.claim({ path: '/old', owner: 'the redirect from /old', kind: 'redirect' })
    expect(served.holds(alias)).toBe(false)
    expect(() => served.claim({ path: '/old', owner: 'public/old', kind: 'public' })).toThrow('the redirect from /old and public/old both serve /old')
  })

  it('serves a path in each locale\'s host apart, which a path served on every host takes from all of them', () => {
    const served = new ServedPaths()

    served.claim({ path: '/about', owner: 'about.kay', kind: 'page', scope: 'fr' })
    served.claim({ path: '/about', owner: 'a-propos.kay', kind: 'page', scope: 'en' })
    expect(() => served.claim({ path: '/about', owner: 'public/about', kind: 'public' })).toThrow('about.kay and public/about both serve /about')
  })

  it('lists what a static export writes in the order it was claimed, asking each claim that lists its own paths', async () => {
    const served = new ServedPaths()

    served.claim({ path: '/sw.js', owner: 'the service worker', kind: 'kay', exported: true })
    served.claim({ path: '/feeds/:slug', owner: '[slug].json.ts', kind: 'endpoint', suffix: '.json', exported: async () => ['/feeds/a.json', '/feeds/b.json'] })
    served.claim({ path: '/about', owner: 'about.kay', kind: 'page' })

    expect(await served.exported()).toEqual(['/sw.js', '/feeds/a.json', '/feeds/b.json'])
  })

  it('refuses a public file at a path a page serves in a locale, and one a redirect takes', async () => {
    const dir = await scratchDir('served-public-')
    const i18n = { locales: ['fr', 'en'], defaultLocale: 'fr', messages: resolve('tests/fixtures/i18n/src/messages') }

    await Bun.write(join(dir, 'en/about'), 'shadowed')
    await Bun.write(join(dir, 'old'), 'moved')
    await expect(pages({ root: 'tests/fixtures/i18n', publicDir: dir, prebuilt: false, i18n })).rejects.toThrow('and a page both serve /en/about')
    await expect(pages({ root: 'tests/fixtures/site', publicDir: dir, prebuilt: false, redirects: { '/old': '/about' } })).rejects.toThrow('/old and the redirect from /old both serve /old; remove one')
  })

  it('serves a public file at a path an HTML file or a translated page only offered', async () => {
    const dir = await scratchDir('served-offers-')
    const routes = join(dir, 'routes')
    const publicDir = join(dir, 'public')

    await Promise.all([
      Bun.write(join(routes, 'index.kay'), 'h1 Home\n'),
      Bun.write(join(routes, 'about.kay'), 'h1 About\n'),
      Bun.write(join(publicDir, 'old.html'), 'old page'),
      Bun.write(join(publicDir, 'about'), 'about file'),
    ])

    const app = await pages({ root: dir, routes: 'routes', publicDir, prebuilt: false, redirects: { '/old': '/' }, i18n: { locales: ['fr', 'en'], defaultLocale: 'fr', messages: resolve('tests/fixtures/i18n/src/messages'), paths: { '/about': { fr: '/a-propos' } } } })
    const visit = async (path: string) => app.handle(new Request(`http://localhost${path}`))

    expect((await visit('/old')).headers.get('location')).toBe('/')
    expect(await (await visit('/old.html')).text()).toBe('old page')
    expect(await (await visit('/about')).text()).toBe('about file')
    expect(await (await visit('/a-propos')).text()).toContain('<h1>About</h1>')
  })

  it('finds in kay check what the boot refuses of the public env module and the feeds', async () => {
    const root = await scratchDir('served-check-')

    await Promise.all([
      Bun.write(join(root, 'src/routes/index.kay'), 'h1 Home\n'),
      Bun.write(join(root, 'public/_kay/env.js'), ''),
      Bun.write(join(root, 'public/rss.xml'), ''),
    ])

    const messages = (await bootProblems(root, { publicEnv: t.Object({}) }, [{ collection: 'posts', path: '/rss.xml', localized: false }])).map(problem => problem.message)

    expect(messages).toEqual([expect.stringMatching(/^kay: `publicEnv` and \S+\/public\/_kay\/env\.js both serve \/_kay\/env\.js$/), expect.stringMatching(/^kay: \S+\/public\/rss\.xml and the feed of the collection posts both serve \/rss\.xml$/)])
  })

  it('exports the paths the server sends to a page of a locale as pages sending there', async () => {
    const root = await scratchDir('served-locales-')

    await Promise.all([
      Bun.write(join(root, 'kay.config.ts'), `import { defineConfig } from 'kay/server'\n\nexport default defineConfig({ i18n: { locales: ['fr', 'en'], defaultLocale: 'fr', prefixDefault: true, paths: { '/about': { fr: '/a-propos' } } } })\n`),
      Bun.write(join(root, 'src/routes/index.kay'), 'h1 Home\n'),
      Bun.write(join(root, 'src/routes/about.kay'), 'h1 About\n'),
      ...['fr', 'en'].map(async locale => Bun.write(join(root, `src/messages/${locale}.ts`), 'import { defineMessages } from \'kay/i18n\'\n\nexport default defineMessages({})\n')),
    ])

    const outdir = join(root, 'dist')
    const child = Bun.spawn([process.execPath, CLI, 'build', root, '--no-check', '--static', '--outdir', outdir], { stdout: 'pipe', stderr: 'pipe' })
    const [errors, code] = await Promise.all([new Response(child.stderr).text(), child.exited])
    const refresh = async (file: string) => (/<meta http-equiv="refresh" content="0; url=([^"]+)">/).exec(await Bun.file(join(outdir, file)).text())?.[1]

    expect({ code, errors }).toMatchObject({ code: 0 })
    expect((await readdir(join(outdir, 'fr'))).sort()).toContain('a-propos.html')
    expect(await refresh('index.html')).toBe('/fr')
    expect(await refresh('about.html')).toBe('/fr/a-propos')
    expect(await refresh('fr/about.html')).toBe('/fr/a-propos')
    expect(await refresh('en/about.html')).toBeUndefined()

    // Under `trailingSlash: 'always'`, the server's slash redirect comes first: each page sends where the path with its slash goes.
    await Bun.write(join(root, 'kay.config.ts'), `import { defineConfig } from 'kay/server'\n\nexport default defineConfig({ base: '/b', trailingSlash: 'always', i18n: { locales: ['fr', 'en'], defaultLocale: 'fr', prefixDefault: true, paths: { '/about': { fr: '/a-propos' } } } })\n`)

    const slashed = Bun.spawn([process.execPath, CLI, 'build', root, '--no-check', '--static', '--outdir', outdir], { stdout: 'pipe', stderr: 'pipe' })
    const [slashErrors, slashCode] = await Promise.all([new Response(slashed.stderr).text(), slashed.exited])

    expect({ code: slashCode, errors: slashErrors }).toMatchObject({ code: 0 })
    expect(await refresh('index.html')).toBe('/b/fr/')
    expect(await refresh('about.html')).toBe('/b/fr/a-propos/')
    expect(await refresh('fr/about.html')).toBe('/b/fr/a-propos/')
    expect(await refresh('en/about.html')).toBeUndefined()
  })
})
