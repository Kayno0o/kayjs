import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'
import { s } from 'kay'
import { clientDir, outputDir } from '../src/build/assets'
import { clientOptionsOf, projectPaths } from '../src/project'

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
    })
    expect(projectPaths(join(root, 'site', '..'), { routes: 'pages', publicDir: 'static', api: 'api', content: 'content.ts', entry: 'server.ts' })).toMatchObject({ root, routes: '/app/pages', public: '/app/static', api: '/app/api', content: '/app/content.ts', entry: '/app/server.ts' })
  })
})

describe('clientOptionsOf', () => {
  it('minifies kay build\'s browser build unless the config says not to, and maps and swaps islands in development', () => {
    expect(clientOptionsOf({ base: '/docs/' }, { dev: false, underKayDev: false }, { exported: true })).toMatchObject({ minify: true, base: '/docs', sourcemap: false, hot: false, inspect: false, exported: true })
    expect(clientOptionsOf({ minify: false }, { dev: false, underKayDev: false }, {}).minify).toBe(false)
    expect(clientOptionsOf({ publicEnv: s.Object({ API: s.String() }) }, { dev: true, underKayDev: true })).toMatchObject({ minify: false, publicEnv: true, sourcemap: true, hot: true, inspect: true })
  })
})
