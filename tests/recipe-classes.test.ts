import { rm, symlink } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import tailwind from 'bun-plugin-tailwind'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { clientDir } from '../src/build/assets'
import { buildClient } from '../src/build/client'
import { liftRecipes } from '../src/build/recipe-classes'
import { transformKayCached } from '../src/build/transform'
import { devBuilder } from '../src/dev/builder'
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

  it('keeps the line of everything after a template literal it replaced', () => {
    const source = wrap('{ parts: { root: `inline-flex\n  items-center`, icon: \'size-3\' } }').replace('span(part="root")', 'span(part="root")\n')
    const lifted = liftRecipes(source, 'src/tag.kay', utility)

    expect(lifted?.source.split('\n').length).toBe(source.split('\n').length)
    expect(lifted?.source.split('\n').findIndex(line => line.startsWith('span'))).toBe(source.split('\n').findIndex(line => line.startsWith('span')))
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
    process.env.KAY_RECIPE_CLASSES = '1'
    root = resolve(await fixtureCopy('recipe-classes'))
    client = await buildClient(root, { plugins: [tailwind] })

    const app = await servePages(resolveProject(root, { dirs: { routes: 'src/routes' }, serve: { compress: false } }, modeOf({ dev: false, prebuilt: true })), () => client)

    html = await (await app.handle(new Request('http://localhost/'))).text()
    css = await Bun.file(join(client.dir, client.styles.get(join(root, 'src/routes/index.kay'))!.slice('/_kay/'.length))).text()
  }, 120_000)

  afterAll(async () => {
    delete process.env.KAY_RECIPE_CLASSES
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

  it('generates a utility only a recipe names once, in the recipe layer', () => {
    for (const name of ['inline-flex', 'items-center', 'gap-1', 'bg-red-600'])
      expect(css).not.toMatch(new RegExp(`\\.${name}\\s*\\{`))
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

describe('the Cases of a lifted recipe', () => {
  const dirs: string[] = []
  const project = async () => {
    const copy = resolve(await fixtureCopy('recipe-classes'))

    dirs.push(copy)

    return copy
  }
  const edit = async (file: string, change: (text: string) => string) => Bun.write(file, change(await Bun.file(file).text()))
  const page = async (copy: string, config: Record<string, unknown> = {}, path = '/') => {
    const client = await buildClient(copy, { plugins: [tailwind] })
    const app = await servePages(resolveProject(copy, { dirs: { routes: 'src/routes' }, serve: { compress: false }, ...config }, modeOf({ dev: false, prebuilt: true })), () => client)
    const html = await (await app.handle(new Request(`http://localhost${path}`))).text()
    const css = await Bun.file(join(client.dir, client.styles.get(join(copy, 'src/routes/index.kay'))!.slice('/_kay/'.length))).text()

    return { client, html, css }
  }

  beforeAll(() => {
    process.env.KAY_RECIPE_CLASSES = '1'
  })

  afterAll(async () => {
    delete process.env.KAY_RECIPE_CLASSES
    installClassTable(undefined)
    await Promise.all(dirs.map(async dir => rm(dir, { recursive: true, force: true })))
  })

  it('keeps what src/ui.ts adds to a part and a variant, written as utilities that beat the lifted ones', async () => {
    const copy = await project()

    await Bun.write(join(copy, 'src/ui.ts'), 'import { defineUi } from \'kay\'\n\nexport default defineUi({ \'./components/tag.kay\': { parts: { root: \'py-9\' }, variants: { tone: { brand: { root: \'bg-blue-700\' } } } } })\n')
    await edit(join(copy, 'src/routes/index.kay'), text => text.replace('Tag(tone="danger") danger', 'Tag(tone="brand") brand'))

    const { html, css } = await page(copy)
    const tag = html.match(/<span[^>]*data-tone="brand"[^>]*>/)?.[0] ?? ''

    expect(tag).toMatch(/class="kui-tag group k[\da-z]{7}/)
    expect(tag).toContain('py-9')
    expect(tag).toContain('bg-blue-700')
    expect(tag).not.toContain('inline-flex')
    expect(css).toMatch(/\.py-9\s*\{/)
    expect(css).toMatch(/\.bg-blue-700\s*\{/)
  }, 120_000)

  it('keeps a rule of a skin or theme.css in `components`, under the recipe\'s layer', async () => {
    const copy = await project()

    await edit(join(copy, 'src/app.css'), text => `${text}\n@layer components { .kui-tag { padding-inline: 99px; } }\n`)

    const { css } = await page(copy)
    const layers = css.match(/@layer ([a-z., ]+);/)?.[1]?.split(/\s*,\s*/) ?? []

    expect(layers.indexOf('components')).toBeGreaterThanOrEqual(0)
    expect(layers.indexOf('components')).toBeLessThan(layers.indexOf('utilities'))
    expect(css).toMatch(/@layer components \{[^@]*\.kui-tag \{\s*padding-inline-start: 99px/)
    expect(css).toMatch(/@layer utilities\.recipe \{/)
  }, 120_000)

  it('gives a part override the part\'s own lifted class and the class passed', async () => {
    const { html } = await page(await project())
    const icon = html.match(/<i[^>]*class="[^"]*\bsize-6\b[^"]*"[^>]*>/)?.[0] ?? ''

    expect(icon).toMatch(/class="k[\da-z]{7}/)
    expect(icon).not.toContain('size-3')
    expect(icon).not.toContain('opacity-70')
  }, 120_000)

  it('gives the island entry the classes it merges at runtime, and none of the recipe\'s', async () => {
    const copy = await project()

    await Bun.write(join(copy, 'src/components/merge.kay'), '---\nimport { signal } from \'kay\'\n\nconst on = signal(false)\n---\nbutton(class={[\'mt-2\', on() ? \'mt-4\' : \'mt-8\']} onClick={() => on.set(!on())}) merge\n')
    await edit(join(copy, 'src/routes/about.kay'), () => '---\nimport Merge from \'../components/merge.kay\'\n---\nMerge\n')

    const { client } = await page(copy)
    const keys = Object.keys(client.classTable?.classes ?? {})

    expect(keys).toEqual(expect.arrayContaining(['mt-2', 'mt-8']))
    expect(keys).not.toContain('inline-flex')
    expect(keys).not.toContain('bg-red-600')
    expect(keys.some(key => (/^k[\da-z]{7}$/).test(key))).toBe(false)
  }, 120_000)

  it('writes no recipe class into the table of an island that merges nothing', async () => {
    const copy = await project()

    await Bun.write(join(copy, 'src/components/live-tag.kay'), '---\nimport { signal } from \'kay\'\n\nconst count = signal(0)\n---\nbutton.live(onClick={() => count.set(count() + 1)}) {count()}\n')

    const keys = Object.keys((await page(copy)).client.classTable?.classes ?? {})

    expect(keys).not.toContain('inline-flex')
    expect(keys.filter(key => (/^k[\da-z]{7}$/).test(key))).toEqual([])
  }, 120_000)

  it('writes the same names in two checkouts of one app, and under a base', async () => {
    const [first, second] = [await project(), await project()]
    const [one, two] = [await page(first), await page(second, { base: '/repo/' })]
    const names = (html: string) => [...html.matchAll(/class="kui-tag group (k[\da-z]{7}) (k[\da-z]{7})/g)].map(match => `${match[1]} ${match[2]}`)

    expect(names(one.html).length).toBeGreaterThan(0)
    expect(names(two.html)).toEqual(names(one.html))
    expect(two.css).toMatch(/@layer utilities\.recipe \{/)
  }, 180_000)

  it('writes the same rules under kay dev as in production', async () => {
    const copy = await project()
    const production = await page(copy)
    const dev = devBuilder(copy, { plugins: [tailwind] })

    expect((await dev(null)).failed).toBe(false)

    const css = (await Promise.all((await Array.fromAsync(new Bun.Glob('**/*.css').scan(clientDir(copy)))).map(async file => Bun.file(join(clientDir(copy), file)).text()))).join('\n')
    const rules = (text: string) => new Set(text.match(/\.k[\da-z]{7}\s*\{/g))

    expect(rules(css).size).toBeGreaterThan(0)
    expect(rules(css)).toEqual(rules(production.css))
    expect(css).not.toMatch(/\.inline-flex\s*\{/)
  }, 180_000)

  it('writes the rule of a recipe a library holds, under the name its component carries', async () => {
    const copy = await project()
    // Inside the project: Bun's runtime plugins are global, so one answering for the first site of the file would name a module outside this one's root.
    const library = join(copy, 'node_modules/tag-lib')

    await Bun.write(join(copy, 'package.json'), '{ "name": "app", "private": true, "dependencies": { "tag-lib": "1.0.0" } }\n')
    await Bun.write(join(library, 'package.json'), '{ "name": "tag-lib", "version": "1.0.0", "type": "module", "peerDependencies": { "kay": "*" }, "exports": { "./*.kay": "./src/*.kay" } }\n')
    await Bun.write(join(library, 'src/badge.kay'), '---\nimport { recipe } from \'kay\'\n\nconst look = recipe({ parts: \'inline-block rounded-full\' })\n---\nspan(part="root") badge\n')
    await edit(join(copy, 'src/routes/index.kay'), text => text.replace('import Tag', 'import Badge from \'tag-lib/badge.kay\'\nimport Tag').replace('\nLiveTag', '\nLiveTag\nBadge'))

    const { html, css } = await page(copy)
    const name = html.match(/<span[^>]*class="(k[\da-z]{7})"[^>]*>badge/)?.[1]

    expect(name).toBeDefined()
    expect(css).toMatch(new RegExp(`\\.${name} \\{\\s+display: inline-block`))
    expect(css).not.toMatch(/\.inline-block\s*\{/)
  }, 120_000)

  it('keeps the rule of a utility a recipe lifted that a markdown, SVG or HTML file names', async () => {
    const copy = await project()

    await Bun.write(join(copy, 'docs/note.md'), 'Use `gap-1` here.\n')
    await Bun.write(join(copy, 'src/icon.svg'), '<svg class="items-center"></svg>\n')
    await Bun.write(join(copy, 'public/page.html'), '<p class="bg-red-600">x</p>\n')

    const { css } = await page(copy)

    for (const name of ['gap-1', 'items-center', 'bg-red-600'])
      expect(css).toMatch(new RegExp(`\\.${name}\\s*\\{`))

    expect(css).not.toMatch(/\.inline-flex\s*\{/)
  }, 120_000)

  it('prunes a variant and an escaped utility a recipe lifted, and keeps them where a file names them', async () => {
    const copy = await project()

    await Bun.write(join(copy, 'src/components/wide.kay'), '---\nimport { recipe } from \'kay\'\n\nconst look = recipe({ parts: \'hover:bg-red-600 w-1/2 mt-3\' })\n---\ndiv(part="root") wide\n')
    await edit(join(copy, 'src/routes/index.kay'), text => `${text.replace('import Tag from \'../components/tag.kay\'', 'import Tag from \'../components/tag.kay\'\nimport Wide from \'../components/wide.kay\'')}Wide\n`)

    const alone = await page(copy)

    expect(alone.css).toMatch(/width: (?:50%|calc\(1 ?\/ ?2 \* 100%\))/)
    expect(alone.css).not.toMatch(/\.hover\\:bg-red-600/)
    expect(alone.css).not.toMatch(/\.w-1\\\/2\s*\{/)
    expect(alone.css).not.toMatch(/\.mt-3\s*\{/)

    await Bun.write(join(copy, 'docs/note.md'), '<p class="hover:bg-red-600 w-1/2">x</p>\n')

    const named = await page(copy)

    expect(named.css).toMatch(/\.hover\\:bg-red-600/)
    expect(named.css).toMatch(/\.w-1\\\/2\s*\{/)
    expect(named.css).not.toMatch(/\.mt-3\s*\{/)
  }, 180_000)

  it('leaves a library stylesheet rule that names a lifted class as written', async () => {
    const copy = await project()
    const library = join(copy, 'node_modules/tag-lib')

    await Bun.write(join(copy, 'package.json'), '{ "name": "app", "private": true, "dependencies": { "tag-lib": "1.0.0" } }\n')
    await Bun.write(join(library, 'package.json'), '{ "name": "tag-lib", "version": "1.0.0", "type": "module", "peerDependencies": { "kay": "*" }, "exports": { "./*.kay": "./src/*.kay", "./*.css": "./src/*.css" } }\n')
    await Bun.write(join(library, 'src/badge.css'), '.inline-flex { outline-color: teal; }\n')
    await Bun.write(join(library, 'src/badge.kay'), '---\nimport \'./badge.css\'\n---\nspan.inline-flex badge\n')
    await edit(join(copy, 'src/routes/index.kay'), text => text.replace('import Tag', 'import Badge from \'tag-lib/badge.kay\'\nimport Tag').replace('\nLiveTag', '\nLiveTag\nBadge'))

    const { css } = await page(copy)

    expect(css).toMatch(/\.inline-flex\s*\{\s*outline-color: teal/)
  }, 120_000)

  it('drops no rule when a stylesheet names a folder outside the root', async () => {
    const copy = await project()

    await edit(join(copy, 'src/app.css'), text => `${text}\n@source "../../outside";\n`)

    expect((await page(copy)).css).toMatch(/\.inline-flex\s*\{/)
  }, 120_000)

  it('keeps the rule of a utility a recipe lifted that a file or an `@source inline` names too', async () => {
    const copy = await project()

    await Bun.write(join(copy, 'src/components/plain.kay'), 'p.gap-1 plain\n')
    await edit(join(copy, 'src/app.css'), text => `${text}\n@source inline("items-center");\n`)
    await edit(join(copy, 'src/routes/index.kay'), text => `${text.replace('import Tag from \'../components/tag.kay\'', 'import Tag from \'../components/tag.kay\'\nimport Plain from \'../components/plain.kay\'')}Plain\n`)

    const { css } = await page(copy)

    expect(css).toMatch(/\.gap-1\s*\{/)
    expect(css).toMatch(/\.items-center\s*\{/)
    expect(css).not.toMatch(/\.inline-flex\s*\{/)
  }, 120_000)

  it('writes the rule of a recipe in a package Bun links from its store once', async () => {
    const copy = await project()
    const library = join(copy, 'node_modules/.bun/recipe-lib@1.0.0/node_modules/recipe-lib')

    await Bun.write(join(copy, 'package.json'), '{ "name": "app", "private": true, "dependencies": { "recipe-lib": "1.0.0" } }\n')
    await Bun.write(join(library, 'package.json'), '{ "name": "recipe-lib", "version": "1.0.0", "type": "module", "peerDependencies": { "kay": "*" }, "exports": { "./*.kay": "./src/*.kay" } }\n')
    await Bun.write(join(library, 'src/badge.kay'), '---\nimport { recipe } from \'kay\'\n\nconst look = recipe({ parts: \'inline-block rounded-full\' })\n---\nspan(part="root") badge\n')
    await symlink('.bun/recipe-lib@1.0.0/node_modules/recipe-lib', join(copy, 'node_modules/recipe-lib'))
    await edit(join(copy, 'src/routes/index.kay'), text => text.replace('import Tag', 'import Badge from \'recipe-lib/badge.kay\'\nimport Tag').replace('\nLiveTag', '\nLiveTag\nBadge'))

    const { html, css } = await page(copy)
    const name = html.match(/<span[^>]*class="(k[\da-z]{7})"[^>]*>badge/)?.[1]

    expect(name).toBeDefined()
    expect(css).toMatch(new RegExp(`\\.${name} \\{\\s+display: inline-block`))
    expect(css).not.toMatch(/\.inline-block\s*\{/)
  }, 120_000)

  it('writes the names and rules of an edited recipe under kay dev', async () => {
    const copy = await project()
    const tag = join(copy, 'src/components/tag.kay')
    const dev = devBuilder(copy, { plugins: [tailwind] })
    const rules = async () => (await Promise.all((await Array.fromAsync(new Bun.Glob('**/*.css').scan(clientDir(copy)))).map(async file => Bun.file(join(clientDir(copy), file)).text()))).join('\n')

    expect((await dev(null)).failed).toBe(false)
    expect(await rules()).not.toContain('text-transform: uppercase')

    await dev([])
    await Bun.sleep(20)
    await edit(tag, text => text.replace('kui-tag group inline-flex', 'kui-tag group inline-flex uppercase'))
    await dev(['src/components/tag.kay'])

    expect(await rules()).toContain('text-transform: uppercase')
  }, 180_000)

  it('writes the rule of a lifted utility under kay dev once a file starts naming it', async () => {
    const copy = await project()
    const tag = join(copy, 'src/components/tag.kay')
    const dev = devBuilder(copy, { plugins: [tailwind] })
    const rules = async () => (await Promise.all((await Array.fromAsync(new Bun.Glob('**/*.css').scan(clientDir(copy)))).map(async file => Bun.file(join(clientDir(copy), file)).text()))).join('\n')

    expect((await dev(null)).failed).toBe(false)
    expect(await rules()).not.toMatch(/\.inline-flex\s*\{/)

    await dev([])
    await Bun.sleep(20)
    // The recipe in this file already holds the word, so only the template's use of it is new.
    await edit(tag, text => text.replace('span(part="root"', 'span.inline-flex(part="root"'))
    await dev(['src/components/tag.kay'])

    expect(await rules()).toMatch(/\.inline-flex\s*\{/)
  }, 180_000)

  it('builds a component with a `--- style` fence beside the recipes, with no scoped stylesheet cached yet', async () => {
    const copy = await project()

    // Bun lists the folder once, at the first stylesheet it resolves there: a fence loaded after the recipes, a few imports down, is written past that listing.
    await Bun.write(join(copy, 'src/components/note.kay'), '--- style\n.note { color: rebeccapurple }\n---\np.note fenced\n')
    await Bun.write(join(copy, 'src/components/outer.kay'), '---\nimport Inner from \'./inner.kay\'\n---\nInner\n')
    await Bun.write(join(copy, 'src/components/inner.kay'), '---\nimport Note from \'./note.kay\'\n---\nNote\n')
    await edit(join(copy, 'src/routes/index.kay'), text => `${text.replace('import Tag from \'../components/tag.kay\'', 'import Tag from \'../components/tag.kay\'\nimport Outer from \'../components/outer.kay\'')}Outer\n`)
    await rm(join(copy, '.kay/cache/scoped'), { recursive: true, force: true })

    const { html, css } = await page(copy)

    expect(html).toContain('fenced')
    expect(css).toMatch(/\.note\[data-k-[\da-z]+\] \{\s+color: #639/)
  }, 120_000)

  it('writes the `--- style` fence of a library in Bun\'s isolated store once, under the name the bundler reaches it by', async () => {
    const copy = await project()
    const library = join(copy, 'node_modules/.bun/fence-lib@1.0.0/node_modules/fence-lib')

    await Bun.write(join(copy, 'package.json'), '{ "name": "app", "private": true, "dependencies": { "fence-lib": "1.0.0" } }\n')
    await Bun.write(join(library, 'package.json'), '{ "name": "fence-lib", "version": "1.0.0", "type": "module", "peerDependencies": { "kay": "*" }, "exports": { "./*.kay": "./src/*.kay" } }\n')
    await Bun.write(join(library, 'src/badge.kay'), '--- style\n.badge { color: rebeccapurple }\n---\nspan.badge badge\n')
    await symlink('.bun/fence-lib@1.0.0/node_modules/fence-lib', join(copy, 'node_modules/fence-lib'))
    await Bun.write(join(copy, 'src/components/outer.kay'), '---\nimport Badge from \'fence-lib/badge.kay\'\n---\nBadge\n')
    await edit(join(copy, 'src/routes/index.kay'), text => `${text.replace('import Tag from \'../components/tag.kay\'', 'import Tag from \'../components/tag.kay\'\nimport Outer from \'../components/outer.kay\'')}Outer\n`)
    await rm(join(copy, '.kay/cache/scoped'), { recursive: true, force: true })

    const { css } = await page(copy)
    const scoped = join(copy, '.kay/cache/scoped')
    const fences = await Promise.all((await Array.fromAsync(new Bun.Glob('*.css').scan(scoped))).map(async file => Bun.file(join(scoped, file)).text()))

    expect(css).toMatch(/\.badge\[data-k-[\da-z]+\] \{\s+color: #639/)
    expect(fences.filter(text => text.includes('.badge[data-k-'))).toHaveLength(1)
  }, 120_000)

  it('leaves an app without Tailwind as written', async () => {
    const copy = await project()

    await Bun.write(join(copy, 'src/app.css'), 'body { margin: 0 }\n')

    const { html } = await page(copy)

    expect(html).toContain('inline-flex')
    expect(html).not.toMatch(/class="[^"]*\bk[\da-z]{7}\b/)
  }, 120_000)
})

describe('a test run', () => {
  it('keeps a recipe\'s classes as written, which the assertions of a test read', async () => {
    const copy = resolve(await fixtureCopy('recipe-classes'))
    const file = join(copy, 'src/components/tag.kay')
    const cacheDir = await scratchDir('recipe-classes-cache-')

    try {
      expect(await transformKayCached(await Bun.file(file).text(), file, { target: 'ssr', root: copy, cacheDir })).toContain('inline-flex')
    }
    finally {
      await Promise.all([rm(copy, { recursive: true, force: true }), rm(cacheDir, { recursive: true, force: true })])
    }
  })
})
