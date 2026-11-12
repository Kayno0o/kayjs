import type { LocalsOf } from '../src/runtime/checks'
import type { KayExtension, KayPlugin, PluginInput, Session } from '../src/server'
import { describe, expect, expectTypeOf, it } from 'bun:test'
import { Elysia } from 'elysia'
import { api, background, queue, schedule, session, shutdown, workflow } from '../src/server'
import { kayPlugin } from '../src/server/plugin'

describe('KayPlugin', () => {
  it('hands the Elysia instance behind it as `elysia`, for every plugin kay builds', () => {
    const plugins = [
      api(),
      session(),
      schedule('1h', () => undefined),
      schedule('1h', () => undefined, { enabled: false }),
      schedule('@hourly', [() => undefined, () => undefined]),
      schedule({ '@hourly': () => undefined, '30s': () => undefined }),
      background(() => undefined),
      background(() => undefined, { enabled: false }),
      queue('plugin-queue', () => undefined),
      workflow('plugin-flow', () => undefined),
    ]

    for (const plugin of plugins) {
      expect(plugin.elysia).toBe(plugin)
      expect(plugin.elysia).toBeInstanceOf(Elysia)
      expect(Object.keys(plugin)).not.toContain('elysia')
    }
  })

  it('gives a plugin its `elysia` once, whatever wraps it again', () => {
    const plain = new Elysia()

    expect(kayPlugin(kayPlugin(plain)).elysia).toBe(plain)
  })

  it('is mounted by Elysia like any instance, once, through itself or through `elysia`', async () => {
    const hits: string[] = []
    const feature = api().get('/ping', () => {
      hits.push('ping')

      return 'pong'
    })
    const app = new Elysia().use(feature)
    const again = new Elysia().use(kayPlugin(feature).elysia)

    expect(await (await app.handle(new Request('http://localhost/ping'))).text()).toBe('pong')
    expect(await (await again.handle(new Request('http://localhost/ping'))).text()).toBe('pong')
    expect(hits).toEqual(['ping', 'ping'])
  })

  it('serves a handler of a plugin used by an app that also uses `session()`', async () => {
    const app = new Elysia().use(session({ secret: 'x'.repeat(32) })).get('/id', ({ session: current }) => typeof current.set)

    expect(await (await app.handle(new Request('http://localhost/id'))).text()).toBe('function')
  })

  it('keeps a plain Elysia instance accepted wherever a plugin is taken', async () => {
    const plain = new Elysia()
    const extension: KayExtension = { name: 'plain', server: plain }
    const built: KayExtension = { name: 'built', server: () => new Elysia() }
    const inputs: PluginInput[] = [plain, api(), session()]

    expect(extension.server).toBe(plain)
    expect(typeof built.server).toBe('function')
    expect(inputs).toHaveLength(3)
    await shutdown(plain)
    await shutdown(api())
  })

  it('types what a plugin adds to the context of the app using it', () => {
    const locals = api<{ org: string }>()
    const app = new Elysia().use(locals).get('/', ({ guard, once }) => ({ guard, once }))

    expectTypeOf<KayPlugin>().toEqualTypeOf<KayPlugin<Record<never, never>, 'global'>>()
    expect(app).toBeInstanceOf(Elysia)
  })

  it('reads the locals of a plugin from its global or its scoped side', () => {
    expectTypeOf<LocalsOf<KayPlugin<{ user: string }>>['user']>().toEqualTypeOf<string>()
    expectTypeOf<LocalsOf<KayPlugin<{ user: string }, 'scoped'>>['user']>().toEqualTypeOf<string>()
    expectTypeOf<LocalsOf<ReturnType<typeof session<{ cart: number }>>>['session']>().toExtend<Session<{ cart: number }>>()
  })
})
