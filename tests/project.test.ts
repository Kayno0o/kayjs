import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import process from 'node:process'
import { describe, expect, it } from 'bun:test'
import { s } from 'kay'
import { clientDir, outputDir, testWorker } from '../src/build/assets'
import { clientOptionsOf, modeOf, offlineOf, PRODUCTION, projectPaths, projectRootOf, renderOptionsOf, resolveProject } from '../src/project'
import { setupPages } from '../src/server/setup'
import { scratchDir } from './scratch'

describe('projectPaths', () => {
  it('gives kay\'s defaults, or what the config names, as absolute paths', () => {
    const root = '/app'

    expect(projectPaths(root)).toEqual({
      root,
      routes: '/app/src/routes',
      public: '/app/public',
      api: '/app/src/api',
      entry: '/app/src/server.ts',
      content: '/app/src/content.config.ts',
      cache: '/app/.kay/cache',
      compile: '/app/.kay/compile',
      output: outputDir(root),
      client: clientDir(root),
      types: '/app/.kay/types',
      classes: `/app/.kay/classes${testWorker()}.txt`,
      tests: '/app/.kay/test',
    })
    expect(projectPaths(join(root, 'site', '..'), { routes: 'pages', publicDir: 'static', api: 'api', content: 'content.ts', entry: 'server.ts' })).toMatchObject({ root, routes: '/app/pages', public: '/app/static', api: '/app/api', content: '/app/content.ts', entry: '/app/server.ts' })
  })
})

describe('projectRootOf', () => {
  it('finds the nearest directory holding a tsconfig.json, up to the workspace when one is given', async () => {
    const root = await scratchDir('project-root')
    const app = join(root, 'apps', 'site')

    try {
      await Bun.write(join(app, 'tsconfig.json'), '{}')
      await Bun.write(join(app, 'src', 'routes', 'index.kay'), '')
      await Bun.write(join(root, 'loose', 'card.kay'), '')

      expect(projectRootOf(join(app, 'src', 'routes', 'index.kay'))).toBe(app)
      expect(projectRootOf(join(app, 'src', 'routes', 'index.kay'), root)).toBe(app)
      expect(projectRootOf(join(app, 'src', 'routes', 'index.kay'), join(app, 'src'))).toBe(join(app, 'src'))
      expect(projectRootOf(join(root, 'loose', 'card.kay'), root)).toBe(root)
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('setupPages', () => {
  it('gives serving and prerendering the routes, matchers, locales, site and render options of one project', async () => {
    const root = process.cwd()
    const client = { entryImports: [], islands: {}, styles: new Map(), pages: new Map(), dir: join(outputDir(root), 'dist') }
    const project = resolveProject(root, { routes: 'tests/fixtures/site/src/routes', site: 'https://x.example', base: '/docs/', images: { resolve: () => undefined } })
    const setup = await setupPages(project, async () => client, true)

    expect(setup.routes.map(route => route.pattern)).toContain('/admin/report')
    expect(setup.matchers).toBeInstanceOf(Map)
    expect(setup.locales.implicit).toBe(true)
    expect(setup.site).toBe('https://x.example/docs')
    expect(setup.renderOptions).toMatchObject({ dev: false, base: '/docs', resolvedImages: true, offline: false })
  })
})

describe('clientOptionsOf', () => {
  it('minifies kay build\'s browser build unless the config says not to, and maps and swaps islands in development', () => {
    expect(clientOptionsOf({ base: '/docs/' }, { dev: false, underKayDev: false }, { exported: true })).toMatchObject({ minify: true, base: '/docs', sourcemap: false, hot: false, inspect: false, exported: true })
    expect(clientOptionsOf({ minify: false }, { dev: false, underKayDev: false }, {}).minify).toBe(false)
    expect(clientOptionsOf({ publicEnv: s.Object({ API: s.String() }) }, { dev: true, underKayDev: true })).toMatchObject({ minify: false, publicEnv: true, sourcemap: true, hot: true, inspect: true })
  })
})

describe('modeOf', () => {
  it('takes the options over NODE_ENV, and never registers the service worker in development', () => {
    const previous = process.env.NODE_ENV

    try {
      process.env.NODE_ENV = 'development'
      expect(modeOf()).toEqual({ dev: true, prebuilt: false, underKayDev: false })
      expect(modeOf({ dev: false, prebuilt: true })).toEqual(PRODUCTION)
      process.env.NODE_ENV = 'production'
      expect(modeOf()).toEqual(PRODUCTION)
    }
    finally {
      if (previous === undefined)
        delete process.env.NODE_ENV
      else
        process.env.NODE_ENV = previous
    }

    const offline = { offline: true as const }

    expect(renderOptionsOf(offline, { dev: true }, { head: undefined, maxDensity: 2 })).toMatchObject({ dev: true, serverTiming: true, offline: false })
    expect(renderOptionsOf({ ...offline, base: '/docs/' }, PRODUCTION, { head: undefined, maxDensity: 2 })).toMatchObject({ dev: false, serverTiming: false, offline: true, base: '/docs', maxDensity: 2 })
    expect(offlineOf({}, PRODUCTION)).toBe(false)
  })
})
