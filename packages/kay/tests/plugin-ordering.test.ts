import { afterAll, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { i18n } from '../../plugin-i18n/src/index'
import { seo } from '../../plugin-seo/src/index'
import { definePlugin, resolvePlugins } from '../src/plugins/index'
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
      'packages/plugin-icons/src/index.ts',
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
