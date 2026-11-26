import { afterAll, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { i18n } from '../../plugin-i18n/src/index'
import { seo } from '../../plugin-seo/src/index'
import { definePlugin, loadConfig, resolvePlugins } from '../src/plugins/index'
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

describe('Plugin ordering, definePlugin & locals validation (#3550)', () => {
  it('sorts plugins stably by enforce (pre -> normal -> post) and after dependencies', () => {
    const post = definePlugin({ name: 'post-a', enforce: 'post' })
    const normalA = definePlugin({ name: 'normal-a', after: ['normal-b'] })
    const normalB = definePlugin({ name: 'normal-b' })
    const pre = definePlugin({ name: 'pre-a', enforce: 'pre' })

    const sorted = resolvePlugins([post, normalA, normalB, pre])
    expect(sorted.map(p => p.name)).toEqual(['pre-a', 'normal-b', 'normal-a', 'post-a'])
  })

  it('rejects circular after dependencies and rejects reading a local before its provider runs', () => {
    const a = definePlugin({ name: 'a', after: ['b'] })
    const b = definePlugin({ name: 'b', after: ['a'] })
    expect(() => resolvePlugins([a, b])).toThrow(/circular plugin `after` dependency/)

    const reader = definePlugin({ name: 'early-reader', enforce: 'pre', readsLocals: ['tenant'] })
    const provider = definePlugin({ name: 'late-provider', enforce: 'post', providesLocals: ['tenant'] })
    expect(() => resolvePlugins([reader, provider])).toThrow(
      /plugin "early-reader" reads ctx\.locals\.tenant before "late-provider" provides it/,
    )
  })

  it('refuses two plugins sharing a name, and an `after` name one typo away from a registered plugin (#3657)', () => {
    expect(() => resolvePlugins([definePlugin({ name: 'cache' }), definePlugin({ name: 'other' }), definePlugin({ name: 'cache' })])).toThrow('kay: two plugins are named "cache" in kay.config.ts: register it once, or give each instance its own `name`.')
    const images = definePlugin({ name: '@kayjs/images' })
    expect(() => resolvePlugins([images, definePlugin({ name: 'gallery', after: ['@kayjs/imgaes'] })])).toThrow('kay: plugin "gallery" runs `after` "@kayjs/imgaes", which no plugin is named: did you mean "@kayjs/images"?')
    expect(() => resolvePlugins([definePlugin({ name: 'ui' }), definePlugin({ name: 'theme', after: ['uix'] })])).toThrow('did you mean "ui"?')
    expect(() => resolvePlugins([definePlugin({ name: 'ui' }), definePlugin({ name: 'theme', after: ['iu'] })])).toThrow('did you mean "ui"?')
    expect(resolvePlugins([definePlugin({ name: 'uixy' }), definePlugin({ name: 'theme', after: ['ui'] })]).map(p => p.name)).toEqual(['uixy', 'theme'])
    expect(() => resolvePlugins([images, definePlugin({ name: 'gallery', after: ['@kayjs/imagexy'] })])).toThrow('did you mean "@kayjs/images"?')
    expect(resolvePlugins([images, definePlugin({ name: 'gallery', after: ['@kayjs/imagesxyz'] })]).map(p => p.name)).toEqual(['@kayjs/images', 'gallery'])
    expect(resolvePlugins([definePlugin({ name: 'gallery', after: ['@kayjs/i18n', '@kayjs/images'] }), images]).map(p => p.name)).toEqual(['@kayjs/images', 'gallery'])
  })

  it('refuses a kay.config.ts key kay does not read, naming the one it most likely meant (#3657)', async () => {
    const dir = makeTemp('kay-config-keys-')
    mkdirSync(join(dir, 'src/routes'), { recursive: true })
    writeFileSync(join(dir, 'src/routes/index.tsx'), 'export default function Home() { return <h1>Hi</h1> }\n')
    writeFileSync(join(dir, 'kay.config.ts'), 'export default { outDirr: \'out\', lang: \'fr\', plugns: [], zzz: 1 }\n')
    await expect(loadConfig(dir, { fresh: true })).rejects.toThrow('kay: "outDirr" is not a kay.config.ts key: did you mean "outDir"?\nkay: "plugns" is not a kay.config.ts key: did you mean "plugins"?\nkay: "zzz" is not a kay.config.ts key: remove it (the keys are site, lang, assetPrefix, security, trustedOrigins, trustProxy, maxRequestBodySize, navigation, streamTimeout, consent, compress, onError, plugins, port, routesDir, outDir, publicDir, compliance)')
    writeFileSync(join(dir, 'kay.config.ts'), 'export default { outDir: \'out\', compliance: {}, port: 3000 }\n')
    expect(await loadConfig(dir, { fresh: true })).toEqual({ outDir: 'out', compliance: {}, port: 3000 })
  })

  it('automatically orders @kayjs/seo after @kayjs/i18n even when seo() is listed first', async () => {
    const dir = makeTemp('kay-plugin-order-')
    mkdirSync(join(dir, 'src/routes'), { recursive: true })
    writeFileSync(join(dir, 'src/routes/index.tsx'), 'export default function Home() { return <h1>Hi</h1> }\n')

    const app = await testApp({
      root: dir,
      plugins: [
        // Listed BEFORE i18n on purpose — core must sort i18n (pre) ahead of seo (after: ['@kayjs/i18n'])
        seo({
          site: 'https://example.com',
          description: { en: 'English desc', fr: 'Description FR' },
        }),
        i18n({
          locales: ['en', 'fr'],
          defaultLocale: 'en',
          site: 'https://example.com',
        }),
      ],
    })

    const frHtml = await (await app.get('/fr')).text()
    expect(frHtml).toContain('lang="fr"')
    expect(frHtml).toContain('content="Description FR"')
  })

  it('every ecosystem plugin uses definePlugin', () => {
    const pluginFiles = [
      'packages/plugin-auth/src/index.ts',
      'packages/plugin-content/src/index.ts',
      'packages/plugin-i18n/src/index.ts',
      'packages/plugin-icons/src/plugin.ts',
      'packages/plugin-images/src/plugin.ts',
      'packages/plugin-live/src/index.ts',
      'packages/plugin-mail/src/index.ts',
      'packages/plugin-mcp/src/index.ts',
      'packages/plugin-seo/src/index.ts',
      'packages/plugin-spa/src/index.ts',
      'packages/plugin-tailwind/src/index.ts',
      'packages/ui/src/plugin.ts',
    ]
    const repoRoot = join(import.meta.dir, '../../..')
    for (const rel of pluginFiles) {
      const src = readFileSync(join(repoRoot, rel), 'utf8')
      expect(src).toContain('definePlugin(')
    }
  })
})

describe('Plugin middleware scoping (#3626)', () => {
  it('runs scope: "dynamic" on static-path routes with load() while skipping pure static/prerendered fast paths', async () => {
    const dir = makeTemp('kay-3626-dynamic-scope-')
    mkdirSync(join(dir, 'src/routes'), { recursive: true })
    writeFileSync(join(dir, 'src/routes/profile.tsx'), `
      import type { RequestContext } from '@kayjs/kay/server'
      export function load(ctx: RequestContext) {
        return { dyn: (ctx.locals as Record<string, string>).dyn ?? 'missing' }
      }
      export default function Profile({ data }: { data: { dyn: string } }) {
        return <p>profile:{data.dyn}</p>
      }
    `)
    writeFileSync(join(dir, 'src/routes/about.tsx'), `
      export default function About() { return <p>static-about</p> }
    `)
    writeFileSync(join(dir, 'src/routes/prerendered.tsx'), `
      export const prerender = true
      export default function Pre() { return <p>pre-page</p> }
    `)

    let dynamicCalls = 0
    const dynPlugin = definePlugin({
      name: 'dyn-scope',
      server(api) {
        api.use(async (ctx, next) => {
          dynamicCalls++
          ;(ctx.locals as Record<string, string>).dyn = 'loaded'
          const res = await next()
          res.headers.set('x-dyn-mw', '1')
          return res
        }, { scope: 'dynamic' })
      },
    })

    const app = await testApp({ root: dir, plugins: [dynPlugin] })
    try {
      const profile = await app.get('/profile')
      expect(profile.status).toBe(200)
      expect(profile.headers.get('x-dyn-mw')).toBe('1')
      expect(await profile.text()).toContain('profile:loaded')
      expect(dynamicCalls).toBe(1)

      const about = await app.get('/about')
      expect(about.status).toBe(200)
      expect(about.headers.get('x-dyn-mw')).toBeNull()

      const pre = await app.get('/prerendered')
      expect(pre.status).toBe(200)
      expect(pre.headers.get('x-dyn-mw')).toBeNull()
      expect(dynamicCalls).toBe(1)
    }
    finally {
      await app.app.dispose?.()
    }
  })

  it('matches path-scoped middleware against actual dynamic pathnames, action route dirs, and plugin routes without leaking', async () => {
    const dir = makeTemp('kay-3626-path-scope-')
    mkdirSync(join(dir, 'src/routes/admin'), { recursive: true })
    mkdirSync(join(dir, 'src/actions'), { recursive: true })

    writeFileSync(join(dir, 'src/routes/[...slug].tsx'), `
      export default function CatchAll({ params, locals }: { params: Record<string, string>, locals: Record<string, string> }) {
        return <p>catchall:{params.slug}:admin={locals.admin ?? 'no'}</p>
      }
    `)
    writeFileSync(join(dir, 'src/routes/admin/actions.ts'), `
      import { action } from '@kayjs/kay/server'
      export const adminAct = action(async (ctx) => ({ admin: (ctx.locals as Record<string, string>).admin ?? 'no' }))
    `)
    writeFileSync(join(dir, 'src/actions/public.ts'), `
      import { action } from '@kayjs/kay/server'
      export const publicAct = action(async (ctx) => ({ admin: (ctx.locals as Record<string, string>).admin ?? 'no' }))
    `)
    writeFileSync(join(dir, 'src/routes/index.tsx'), `
      import { adminAct } from './admin/actions'
      import { publicAct } from '../actions/public'
      export default function Home() {
        return (
          <div>
            <form action={adminAct} method="post"><button>a</button></form>
            <form action={publicAct} method="post"><button>p</button></form>
          </div>
        )
      }
    `)

    const scopedPlugin = definePlugin({
      name: 'admin-scope',
      server(api) {
        api.use(async (ctx, next) => {
          ;(ctx.locals as Record<string, string>).admin = 'yes'
          const res = await next()
          res.headers.set('x-admin-scope', '1')
          return res
        }, { scope: '/admin' })
        api.route('GET', '/admin/stats', ctx => ctx.json({ admin: (ctx.locals as Record<string, string>).admin ?? 'no' }))
        api.route('GET', '/auth/session', ctx => ctx.json({ admin: (ctx.locals as Record<string, string>).admin ?? 'no' }))
      },
    })

    const app = await testApp({ root: dir, plugins: [scopedPlugin] })
    try {
      // Dynamic catch-all route matches scope: '/admin' on actual request pathname (including percent-encoded)
      const adminCatch = await app.get('/admin/users')
      expect(adminCatch.status).toBe(200)
      expect(adminCatch.headers.get('x-admin-scope')).toBe('1')
      expect(await adminCatch.text()).toContain('catchall:admin/users:admin=yes')

      const encodedAdminCatch = await app.get('/%61dmin/users')
      expect(encodedAdminCatch.status).toBe(200)
      expect(encodedAdminCatch.headers.get('x-admin-scope')).toBe('1')

      const publicCatch = await app.get('/public/users')
      expect(publicCatch.status).toBe(200)
      expect(publicCatch.headers.get('x-admin-scope')).toBeNull()
      expect(await publicCatch.text()).toContain('catchall:public/users:admin=no')

      // Actions under src/routes/admin/ run scope: '/admin'; actions outside routes/ do not
      const adminMod = await app.import('src/routes/admin/actions.ts') as { adminAct: unknown }
      const adminActRes = await app.submit(adminMod.adminAct as never, {})
      expect(adminActRes.headers.get('x-admin-scope')).toBe('1')
      expect(await adminActRes.json()).toEqual({ ok: true, data: { admin: 'yes' } })

      const pubMod = await app.import('src/actions/public.ts') as { publicAct: unknown }
      const pubActRes = await app.submit(pubMod.publicAct as never, {})
      expect(pubActRes.headers.get('x-admin-scope')).toBeNull()
      expect(await pubActRes.json()).toEqual({ ok: true, data: { admin: 'no' } })

      // Plugin routes: scope: '/admin' runs on /admin/stats and does NOT leak onto /auth/session
      const adminPluginRes = await app.get('/admin/stats')
      expect(adminPluginRes.headers.get('x-admin-scope')).toBe('1')
      expect(await adminPluginRes.json()).toEqual({ admin: 'yes' })

      const authPluginRes = await app.get('/auth/session')
      expect(authPluginRes.headers.get('x-admin-scope')).toBeNull()
      expect(await authPluginRes.json()).toEqual({ admin: 'no' })
    }
    finally {
      await app.app.dispose?.()
    }
  })
})
