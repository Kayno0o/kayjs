import { afterAll, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { testApp } from '../src/test/index'
import { createNavigation, KEEP_SCROLL_SCRIPT, keepScrollTag } from '../src/ssr/navigation'

const tempDirs: string[] = []
function appWith(files: Record<string, string>, navigation = ''): string {
  const dir = mkdtempSync(join(tmpdir(), 'kay-navigation-'))
  tempDirs.push(dir)
  mkdirSync(join(dir, 'node_modules/@kayjs'), { recursive: true })
  symlinkSync(join(import.meta.dir, '..'), join(dir, 'node_modules/@kayjs/kay'), 'dir')
  const all: Record<string, string> = {
    'kay.config.ts': `import { defineConfig } from '@kayjs/kay/config'\nexport default defineConfig({ ${navigation} })`,
    ...files,
  }
  for (const [file, text] of Object.entries(all)) {
    mkdirSync(join(dir, file, '..'), { recursive: true })
    writeFileSync(join(dir, file), text)
  }
  return dir
}

afterAll(() => {
  for (const d of tempDirs)
    rmSync(d, { recursive: true, force: true })
})

const hash = (text: string): string => `'sha256-${new Bun.CryptoHasher('sha256').update(text).digest('base64')}'`
const PAGE = { 'src/routes/index.tsx': 'export default function Home() { return <main><a href="/about">About</a></main> }' }

describe('plain page changes: view transitions and speculation rules, with 0 B of JS (#3641)', () => {
  it('gives every page a view transition off under reduced motion, and a hover prefetch of same-origin links', async () => {
    const app = await testApp({ root: appWith(PAGE) })
    const res = await app.get('/')
    const html = await res.text()
    expect(html).toContain('<style>@media (prefers-reduced-motion:no-preference){@view-transition{navigation:auto}}</style>')
    const rules = JSON.parse(/<script type="speculationrules">([\s\S]*?)<\/script>/.exec(html)![1]!)
    expect(rules.prefetch).toHaveLength(1)
    expect(rules.prefetch[0].eagerness).toBe('moderate')
    expect(rules.prerender).toBeUndefined()
    expect(rules.prefetch[0].where.and).toContainEqual({ href_matches: '/*' })
    expect(JSON.stringify(rules)).toContain('data-kay-no-prefetch')
    // 0 B of JS: only the rules, which are data
    expect(html).not.toContain('<script src')
    expect(html).not.toContain('type="module"')
  })

  it('hashes the style and the rules in the CSP, so a strict policy lets them through', async () => {
    const app = await testApp({ root: appWith(PAGE) })
    const res = await app.get('/')
    const html = await res.text()
    const csp = res.headers.get('content-security-policy')!
    const style = /<style>(@media[^<]*)<\/style>/.exec(html)![1]!
    const rules = /<script type="speculationrules">([\s\S]*?)<\/script>/.exec(html)![1]!
    expect(csp).toContain(hash(style))
    expect(csp).toContain(hash(rules))
    expect(/style-src ([^;]*)/.exec(csp)![1]).not.toContain('unsafe-inline')
  })

  it('never prefetches a kay route (an action among them), a marked link, a download or a nofollow link, nor another origin', async () => {
    const app = await testApp({ root: appWith(PAGE) })
    const rules = JSON.parse(/<script type="speculationrules">([\s\S]*?)<\/script>/.exec(await (await app.get('/')).text())![1]!)
    const { and } = rules.prefetch[0].where
    expect(and[0]).toEqual({ href_matches: '/*' })
    expect(and).toContainEqual({ not: { href_matches: '/_kay/*' } })
    expect(and).toContainEqual({ not: { selector_matches: '[data-kay-no-prefetch], [data-kay-no-prefetch] a, [download], [rel~=nofollow]' } })
  })

  it('turns each part off in kay.config.ts', async () => {
    const off = await testApp({ root: appWith(PAGE, 'navigation: { viewTransitions: false, prefetch: false }') })
    const res = await off.get('/')
    const html = await res.text()
    expect(html).not.toContain('view-transition')
    expect(html).not.toContain('speculationrules')
    expect(res.headers.get('content-security-policy')).not.toContain(hash('@media (prefers-reduced-motion:no-preference){@view-transition{navigation:auto}}'))

    const vtOnly = await testApp({ root: appWith(PAGE, 'navigation: { prefetch: false }') })
    const vtHtml = await (await vtOnly.get('/')).text()
    expect(vtHtml).toContain('@view-transition')
    expect(vtHtml).not.toContain('speculationrules')

    const prefetchOnly = await testApp({ root: appWith(PAGE, 'navigation: { viewTransitions: false }') })
    const prefetchHtml = await (await prefetchOnly.get('/')).text()
    expect(prefetchHtml).not.toContain('@view-transition')
    expect(prefetchHtml).toContain('speculationrules')
  })

  it('prerenders only when the app asks, at the level it names', () => {
    expect(createNavigation(undefined).html).not.toContain('"prerender"')
    expect(createNavigation({ prerender: false }).html).not.toContain('"prerender"')
    const on = JSON.parse(/>([^<]*)<\/script>/.exec(createNavigation({ prerender: true }).html)![1]!)
    expect(on.prerender[0].eagerness).toBe('moderate')
    expect(on.prefetch[0].eagerness).toBe('moderate')
    const eager = JSON.parse(/>([^<]*)<\/script>/.exec(createNavigation({ prefetch: 'conservative', prerender: 'eager' }).html)![1]!)
    expect(eager.prerender[0].eagerness).toBe('eager')
    expect(eager.prefetch[0].eagerness).toBe('conservative')
    expect(JSON.parse(/>([^<]*)<\/script>/.exec(createNavigation({ prefetch: false, prerender: true }).html)![1]!).prefetch).toBeUndefined()
  })

  it('refuses a setting the browser would ignore', () => {
    expect(() => createNavigation({ prefetch: 'hover' as never })).toThrow(/^kay: navigation\.prefetch is "hover" in kay\.config\.ts: use/)
    expect(() => createNavigation({ prefetch: true as never })).toThrow(/navigation\.prefetch is true/)
    expect(() => createNavigation({ prerender: 'sometimes' as never })).toThrow(/navigation\.prerender/)
  })
})

describe('a marked panel keeps its scroll across page loads: the script, its CSP and its checks (#3639)', () => {
  const marked = 'export default function Home() { return <main><ul data-kay-keep-scroll="side"><li>one</li></ul></main> }'

  it('inlines the script only on a page using the attribute, and its hash is in the CSP', async () => {
    const app = await testApp({ root: appWith({ 'src/routes/index.tsx': marked, 'src/routes/plain.tsx': 'export default function P() { return <p>plain</p> }' }) })
    const res = await app.get('/')
    const html = await res.text()
    expect(html).toContain(`<script>${KEEP_SCROLL_SCRIPT}</script></body>`)
    expect(res.headers.get('content-security-policy')).toContain(hash(KEEP_SCROLL_SCRIPT))
    expect(await (await app.get('/plain')).text()).not.toContain('kay-scroll')
  })

  it('answers from the zero-overhead path of a static page too', async () => {
    const app = await testApp({ root: appWith({ 'src/routes/index.tsx': marked }) })
    expect(await (await app.get('/')).text()).toContain(KEEP_SCROLL_SCRIPT)
  })

  it('throws when two elements of a page share a key, as a layout and a page may', () => {
    expect(() => keepScrollTag('<ul data-kay-keep-scroll="side"></ul><div data-kay-keep-scroll="side"></div>')).toThrow(/^kay: data-kay-keep-scroll="side" is on two elements of one page: give each panel its own key\.$/)
    expect(keepScrollTag('<ul data-kay-keep-scroll="side"></ul><div data-kay-keep-scroll="main"></div>')).toContain('<script>')
    expect(keepScrollTag('<p>none</p>')).toBe('')
  })
})
