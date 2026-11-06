import { realpathSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'bun:test'
import { compileKay } from '../src/compiler'
import { loadConfig, withConfig } from '../src/config-loader'
import { planReload } from '../src/dev/reload'
import { loadContextValues, useContexts } from '../src/server/context-values'
import { kayCheck } from './check-helper'
import { loads } from './fixtures/app-context/src/state'
import { fixtureCopy, scratchDir } from './scratch'
import { pages } from './shared-pages'

const FIXTURE = 'tests/fixtures/app-context'
const I18N = { locales: ['en', 'fr'], defaultLocale: 'en' }

interface Variant { base: string, dev: boolean, locale: boolean }

const variants: Variant[] = [false, true].flatMap(dev => ['', '/repo'].flatMap(base => [false, true].map(locale => ({ dev, base, locale }))))
const apps = new Map<string, ReturnType<typeof pages>>()

// A request to the app listing no extension: its `src/context.ts` is all that gives the templates `ctx`.
async function get(variant: Variant, path: string, headers: Record<string, string> = {}) {
  const key = JSON.stringify(variant)
  let held = apps.get(key)

  if (!held) {
    held = pages({ root: FIXTURE, prebuilt: false, security: false, inlineStyles: false, site: 'https://site.example', dev: variant.dev, base: variant.base || undefined, i18n: variant.locale ? I18N : undefined })
    apps.set(key, held)
  }

  loads.length = 0

  const response = await (await held).handle(new Request(`http://localhost${variant.locale ? '/fr' : ''}${path}`, { headers }))

  return { status: response.status, html: await response.text(), headers: response.headers, loads: [...loads] }
}

describe('the app\'s src/context.ts', () => {
  for (const variant of variants) {
    const label = `${variant.dev ? 'dev' : 'production'}, base ${variant.base || 'unset'}, ${variant.locale ? 'locale prefix' : 'no locale'}`

    it(`gives a layout and a page their values with no extension, a promise and a per-request one, ${label}`, async () => {
      const ada = await get(variant, '/home', { 'x-cart': '3', 'x-plan': 'pro' })
      const bob = await get(variant, '/home', { 'x-cart': '5' })

      expect(ada.status).toBe(200)
      expect(ada.html).toContain('Cart (3)')
      expect(ada.html).toContain('<p id="plan">pro</p>')
      expect(bob.html).toContain('Cart (5)')
      expect(bob.html).toContain('<p id="plan">free</p>')
      expect(ada.headers.get('cache-control')).toBe('private, no-cache')
    })

    it(`loads only the keys the page reads, ${label}`, async () => {
      const home = await get(variant, '/home', { 'x-cart': '1' })
      const other = await get(variant, '/other', { 'x-cart': '1' })

      expect(home.loads.sort()).toEqual(['cart', 'plan'])
      expect(other.loads).toEqual(['cart'])
    })
  }

  it('is listed as an extension unless one names that file already', async () => {
    const root = resolve(FIXTURE)
    const listed = await loadConfig(root)

    expect(listed.extensions?.map(({ name, context }) => [name, context])).toEqual([['src/context.ts', './src/context.ts']])

    const dir = await scratchDir('app-context-none-')

    expect((await loadConfig(dir)).extensions ?? []).toEqual([])
  })

  it('is listed once when the options name that file too', async () => {
    const root = resolve(FIXTURE)
    const config = await withConfig(root, { extensions: [{ name: 'again', context: './src/context.ts' }] })

    expect(config.extensions?.map(({ name }) => name)).toEqual(['again'])
  })

  it('needs a new process in kay dev when the file is added or removed, and reloads an edit of it', async () => {
    const dir = await scratchDir('app-context-dev-')

    await Bun.write(join(dir, 'src/server.ts'), '')
    await Bun.write(join(dir, 'kay.config.ts'), 'export default {}\n')
    await Bun.write(join(dir, 'src/context.ts'), 'export default 1\n')

    const real = realpathSync(dir)
    const at = (file: string) => join(real, file)
    const input = { root: dir, owned: [at('src/routes'), at('src/api')], config: at('kay.config.ts'), entry: at('src/server.ts') }
    const loaded = ['src/context.ts', 'src/server.ts', 'kay.config.ts'].map(at)

    // Added: no module of the running process.
    expect(planReload({ ...input, loaded: loaded.slice(1), changed: ['src/context.ts'] })).toEqual({ restart: 'src/context.ts is the app\'s context' })
    expect('evict' in planReload({ ...input, loaded, changed: ['src/context.ts'] })).toBe(true)
    await rm(at('src/context.ts'))
    expect(planReload({ ...input, loaded, changed: ['src/context.ts'] })).toEqual({ restart: 'src/context.ts is the app\'s context' })
  })

  it('is no island\'s to read', () => {
    const island = '---\nimport { signal } from "kay"\nconst n = signal(0)\n---\nbutton(click={() => n++}) {ctx.plan} {n()}\n'

    expect(compileKay(island, 'test.kay').diagnostics.map(d => d.message)).toEqual([expect.stringContaining('`ctx` is read on the server')])
  })

  it('types ctx in kay check, and flags a key it does not give', async () => {
    const root = await fixtureCopy('app-context')

    await Bun.write(resolve(root, 'tsconfig.json'), await Bun.file('tests/fixtures/action-streams/tsconfig.json').text())
    await Bun.write(resolve(root, 'src/routes/typed.kay'), 'p#typed {ctx.plan.length} {ctx.cartCount.toFixed(0)}\n')
    await Bun.write(resolve(root, 'src/routes/untyped.kay'), 'p#untyped {ctx.nope}\n')

    const { output, report } = await kayCheck([root])
    const text = output + report

    expect(text).toContain('untyped.kay')
    expect(text).toContain('\'nope\'')
    expect(text).not.toContain('routes/typed.kay')
  })

  it('stops a key an extension and the app both give, naming both', async () => {
    const request = new Request('http://localhost/twice')
    const app = resolve(FIXTURE, 'src/context.ts')
    const dir = await scratchDir('app-context-twice-')
    const other = resolve(dir, 'other.ts')

    await Bun.write(other, 'import { defineContext } from \'kay/library\'\n\nexport default defineContext({ plan: () => \'x\' })\n')
    useContexts(request, [app, other], false)

    let failure = ''

    try {
      await loadContextValues(request)
    }
    catch (error) {
      failure = (error as Error).message
    }

    expect(failure).toContain('two extensions give ctx.plan')
    expect(failure).toContain(app)
    expect(failure).toContain(other)
  })
})
