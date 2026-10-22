import type { DevTool } from '../src/runtime/dev-tool'
import { join, relative } from 'node:path'
import process from 'node:process'
import { describe, expect, it } from 'bun:test'
import { loadDevModules } from '../src/runtime/dev-tool'
import { scratchDir } from './scratch'
import { pages } from './shared-pages'

const MODULE_PATHS = /"(\/_kay\/dev\/extension\/[^"]+)"/g

// A site whose extensions name browser modules, one in TypeScript, and a library file the extensions do not name.
async function site() {
  const dir = await scratchDir('dev-tool-modules-')
  const routes = join(dir, 'routes')

  await Promise.all([
    Bun.write(join(routes, 'index.kay'), 'p Home\n'),
    Bun.write(join(dir, 'secret.txt'), 'not served'),
    Bun.write(join(dir, 'one.ts'), 'import type { DevTool } from \'kay/dev-tool\'\n\nexport default function (tool: DevTool): void {\n  tool.tab({ id: \'one\', label: \'One\' })\n}\n'),
    Bun.write(join(dir, 'two.js'), 'export default () => undefined\n'),
  ])

  return { root: relative(process.cwd(), dir), routes: 'routes', dir }
}

const get = async (app: Awaited<ReturnType<typeof pages>>, path: string) => app.handle(new Request(`http://localhost${path}`))

async function loaded(app: Awaited<ReturnType<typeof pages>>): Promise<string[]> {
  return [...(await (await get(app, '/_kay/dev/tool.js')).text()).matchAll(MODULE_PATHS)].map(match => match[1]!)
}

describe('the dev tool modules of extensions', () => {
  it('serves the libraries\' own modules as browser code with no import left', async () => {
    const { root, routes } = await site()
    const modules = ['auth', 'mail', 'cms'].map(name => ({ name, devTool: { module: join(import.meta.dir, '..', 'packages', name, 'src', 'devTool.ts') } }))
    const app = await pages({ root, routes, dev: true, extensions: modules })
    const urls = await loaded(app)

    expect(urls).toHaveLength(3)

    for (const url of urls) {
      const response = await get(app, url)
      const body = await response.text()

      expect(response.status).toBe(200)
      expect(body).toContain('export default')
      expect(body).not.toMatch(/^import /m)
    }
  })

  it('loads each module an extension names after the tool, served as browser code, and nothing else', async () => {
    const { root, routes, dir } = await site()
    const app = await pages({ root, routes, dev: true, extensions: [{ name: 'one', devTool: { module: join(dir, 'one.ts') } }, { name: 'two', devTool: { module: join(dir, 'two.js') } }] })
    const urls = await loaded(app)

    expect(urls).toHaveLength(2)

    const tool = await (await get(app, '/_kay/dev/tool.js')).text()

    expect(tool.indexOf('window.$kayDev = startDevTool()')).toBeLessThan(tool.indexOf('loadDevModules(window.$kayDev'))

    const one = await get(app, urls[0]!)

    expect(one.headers.get('content-type')).toContain('javascript')
    expect(one.headers.get('cache-control')).toBe('no-store')
    expect(await one.text()).not.toContain('import type')
    expect(await (await get(app, urls[1]!)).text()).toContain('export default')
    expect((await get(app, '/_kay/dev/extension/secret.txt')).status).toBe(404)
    expect((await get(app, '/_kay/dev/extension/..%2Fsecret.txt')).status).toBe(404)
    expect((await get(app, '/_kay/dev/extension/9.js')).status).toBe(404)
  })

  it('loads a file two extensions name once, and relative to the project root', async () => {
    const { root, routes, dir } = await site()
    const file = join(dir, 'one.ts')
    const app = await pages({ root, routes, dev: true, extensions: [{ name: 'a', devTool: { module: file } }, { name: 'b', devTool: { module: relative(dir, file) } }] })

    expect(await loaded(app)).toHaveLength(1)
  })

  it('adds nothing for an app whose extensions name no module, and serves nothing in production', async () => {
    const { root, routes, dir } = await site()
    const plain = await pages({ root, routes, dev: true, extensions: [{ name: 'plain' }] })

    expect(await (await get(plain, '/_kay/dev/tool.js')).text()).not.toContain('loadDevModules(window.$kayDev')

    const served = await pages({ root, routes, extensions: [{ name: 'one', devTool: { module: join(dir, 'one.ts') } }] })

    expect((await get(served, '/_kay/dev/tool.js')).status).toBe(404)
    expect((await get(served, '/_kay/dev/extension/0.js')).status).toBe(404)
    expect(await (await get(served, '/')).text()).not.toContain('/_kay/dev/')
  })

  it('serves the modules where the tool is, under a base and either trailing slash setting', async () => {
    const { root, routes, dir } = await site()

    for (const trailingSlash of ['always', 'never'] as const) {
      const app = await pages({ root, routes, dev: true, base: '/docs', trailingSlash, extensions: [{ name: 'one', devTool: { module: join(dir, 'one.ts') } }] })
      const [url] = await loaded(app)

      expect((await get(app, url!)).status).toBe(200)
      expect((await get(app, '/_kay/dev/tool.js')).status).toBe(200)
    }
  })
})

describe('loading the modules in the browser', () => {
  const tool = {} as DevTool

  it('calls each default export with the tool, in order, and logs one that fails to load or throws without stopping the others', async () => {
    const calls: string[] = []
    const logged: string[] = []
    const modules: Record<string, () => Promise<unknown>> = {
      '/a': async () => ({ default: (received: DevTool) => void calls.push(received === tool ? 'a' : 'wrong') }),
      '/b': async () => Promise.reject(new Error('404')),
      '/c': async () => ({ default: () => {
        throw new Error('boom')
      } }),
      '/d': async () => ({ default: async () => {
        await Promise.resolve()
        calls.push('d')
      } }),
      '/e': async () => ({}),
    }

    await loadDevModules(tool, Object.keys(modules).map(url => ({ name: `lib${url}`, url })), async url => modules[url]!(), message => logged.push(message))

    expect(calls).toEqual(['a', 'd'])
    expect(logged).toEqual([
      '[kay] the dev tool module of lib/b failed to load: 404',
      '[kay] the dev tool module of lib/c failed: boom',
      '[kay] the dev tool module of lib/e exports no default function',
    ])
  })
})
