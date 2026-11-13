import { rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import tailwind from 'bun-plugin-tailwind'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { buildClient } from '../src/build/client'
import { liftRecipes } from '../src/build/recipe-classes'
import { transformKayCached } from '../src/build/transform'
import { modeOf, resolveProject } from '../src/project'
import { installClassTable } from '../src/runtime/class-table'
import { servePages } from '../src/server/app'
import { fixtureCopy, scratchDir } from './scratch'

const UTILITIES = new Set(['inline-flex', 'items-center', 'gap-1', 'px-2', 'py-1', 'text-sm', 'bg-gray-100', 'bg-red-600', 'text-white', 'data-stamp:px-4', 'size-3', 'rounded', 'p-4', 'font-bold', 'flex'])
const utility = (token: string) => UTILITIES.has(token)
const wrap = (config: string) => `---\nimport { recipe } from 'kay'\n\nconst look = recipe(${config})\n---\nspan(part="root")\n`

describe('liftRecipes', () => {
  it('replaces the utilities of each class list by one class, keeping the classes Tailwind does not know', () => {
    const lifted = liftRecipes(wrap('{ parts: { root: \'kui-tag group inline-flex items-center gap-1\', icon: \'size-3\' }, variants: { tone: { danger: \'bg-red-600 text-white\' } } }'), 'src/tag.kay', utility)

    expect(lifted?.source).toMatch(/root: "kui-tag group k[\da-z]{7}"/)
    expect(lifted?.source).toMatch(/icon: "k[\da-z]{7}"/)
    expect(lifted?.source).toMatch(/danger: "k[\da-z]{7}"/)
    expect(lifted?.source).not.toContain('inline-flex')
    expect(lifted?.rules).toContain('@layer utilities.recipe {')
    expect(lifted?.rules).toContain('{ @apply inline-flex items-center gap-1; }')
    expect(lifted?.rules).toContain('{ @apply bg-red-600 text-white; }')
  })

  it('writes the base before the variants, whatever order the config is written in', () => {
    const lifted = liftRecipes(wrap('{ variants: { tone: { danger: \'bg-red-600 text-white\' } }, parts: \'inline-flex items-center\' }'), 'src/tag.kay', utility)
    const rules = lifted?.rules ?? ''

    expect(rules.indexOf('inline-flex')).toBeLessThan(rules.indexOf('bg-red-600'))
  })

  it('names a class by its module and place, so the same list in two modules never shares a rule', () => {
    const source = wrap('{ parts: \'inline-flex items-center\' }')
    const first = liftRecipes(source, 'src/a.kay', utility)!
    const second = liftRecipes(source, 'src/b.kay', utility)!

    expect(first.source).not.toBe(second.source)
    expect(liftRecipes(source, 'src/a.kay', utility)?.source).toBe(first.source)
  })

  it('lifts a lone utility too, so none stays in the app\'s layer over a variant\'s', () => {
    expect(liftRecipes(wrap('{ parts: \'flex\' }'), 'src/a.kay', utility)?.rules).toContain('@apply flex;')
  })

  it('leaves a list with no utility', () => {
    expect(liftRecipes(wrap('{ parts: \'kui-tag group\' }'), 'src/a.kay', utility)).toBeUndefined()
  })

  it('leaves what it cannot read: a computed list, a template with a value, a recipe that is not a const', () => {
    expect(liftRecipes(wrap('{ parts: `inline-flex ${gap}` }'), 'src/a.kay', utility)).toBeUndefined()
    expect(liftRecipes(wrap('{ parts: BASE }'), 'src/a.kay', utility)).toBeUndefined()
    expect(liftRecipes('---\nimport { recipe } from \'kay\'\nrecipe({ parts: \'inline-flex items-center\' })\n---\nspan\n', 'src/a.kay', utility)).toBeUndefined()
  })

  it('lifts a list written as a template with no value', () => {
    expect(liftRecipes(wrap('{ parts: `inline-flex items-center` }'), 'src/a.kay', utility)?.source).toMatch(/parts: "k[\da-z]{7}"/)
  })

  it('never writes a token that could end the rule, whatever Tailwind says of it', () => {
    const lifted = liftRecipes(wrap('{ parts: \'inline-flex items-center [a:b;}@import_x]\' }'), 'src/a.kay', () => true)

    expect(lifted?.rules).toContain('@apply inline-flex items-center;')
    expect(lifted?.source).toContain('[a:b;}@import_x]')
  })

  it('is none for a source with no recipe or a script that does not parse', () => {
    expect(liftRecipes('span\n', 'src/a.kay', utility)).toBeUndefined()
    expect(liftRecipes('---\nconst look = recipe({ parts: \'inline-flex items-center\'\n---\nspan\n', 'src/a.kay', utility)).toBeUndefined()
  })
})

describe('an app with Tailwind', () => {
  let root = ''
  let client: Awaited<ReturnType<typeof buildClient>>
  let html = ''
  let css = ''

  beforeAll(async () => {
    root = resolve(await fixtureCopy('recipe-classes'))
    client = await buildClient(root, { plugins: [tailwind] })

    const app = await servePages(resolveProject(root, { dirs: { routes: 'src/routes' }, serve: { compress: false } }, modeOf({ dev: false, prebuilt: true })), () => client)

    html = await (await app.handle(new Request('http://localhost/'))).text()
    css = await Bun.file(join(client.dir, client.styles.get(join(root, 'src/routes/index.kay'))!.slice('/_kay/'.length))).text()
  }, 120_000)

  afterAll(async () => {
    installClassTable(undefined)
    await rm(root, { recursive: true, force: true })
  })

  it('writes the recipe classes in the HTML as short classes, the names of the component kept', () => {
    expect(html).toMatch(/class="kui-tag group k[\da-z]{7} k[\da-z]{7}/)
    expect(html).not.toContain('class="kui-tag group inline-flex')
    expect(html).not.toContain('text-gray-700 data-stamp')
  })

  it('writes the utilities in a layer under the app\'s own', () => {
    expect(css).toMatch(/\.k[\da-z]{7} \{\s+display: inline-flex/)
    expect(css.indexOf('@layer theme, base, components, utilities')).toBeLessThan(css.indexOf('@layer utilities.recipe'))
  })

  it('keeps the utilities an app passes in `class`, which win by layer', () => {
    expect(html).toMatch(/class="[^"]*\bpx-6\b/)
    expect(css).toMatch(/\.px-6\s*\{/)
  })

  it('leaves the island no recipe string and no table of them', async () => {
    const script = (await Promise.all((await Array.fromAsync(new Bun.Glob('**/*.js').scan(client.dir))).map(async file => Bun.file(join(client.dir, file)).text()))).join('\n')

    expect(script).not.toContain('inline-flex')
    expect(script).not.toContain('"bg-red-600')
  })

  it('compiles a component the same on the server and in the browser, from the one name', async () => {
    const cacheDir = await scratchDir('recipe-classes-cache-')
    const file = join(root, 'src/components/tag.kay')
    const source = await Bun.file(file).text()

    try {
      const server = await transformKayCached(source, file, { target: 'ssr', root, cacheDir })
      const browser = await transformKayCached(source, file, { target: 'dom', root, cacheDir })
      const names = (code: string) => [...code.matchAll(/k[\da-z]{7}/g)].map(match => match[0])

      expect(names(server).length).toBeGreaterThan(0)
      expect(new Set(names(browser))).toEqual(new Set(names(server)))
      expect(server).not.toContain('inline-flex')
    }
    finally {
      await rm(cacheDir, { recursive: true, force: true })
    }
  })
})
