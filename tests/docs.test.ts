import type { RenderedPage } from 'kay/server'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { brotliCompressSync } from 'node:zlib'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { fileTree, pathTree } from '../docs/src/file-tree'
import { loadComponents, loadLibraries } from '../docs/src/libraries'
import { pageWeight } from '../docs/src/page-weight'
import { PALETTES, paletteStylesheet, themeCss } from '../docs/src/palettes'
import { loadReference } from '../docs/src/reference'
import { partOf } from '../docs/src/sections'
import { palette, pickTheme, scheme, THEME_SCRIPT, THEMES } from '../docs/src/theme'
import { brokenLinks, LINK } from '../scripts/links'
import { compileKay, formatDiagnostic } from '../src/compiler'
import { LINTS } from '../src/compiler/lints'
import { formatKay } from '../src/format'
import { sendValue } from '../src/runtime/send'

const root = join(import.meta.dir, '..')
// The CSS variable a highlighted token takes its colour from, and one the docs' stylesheet sets.
const SHIKI_COLOUR = /color:var\((--shiki-[\w-]+)\)/g
const SHIKI_ALIAS = /^\s*(--shiki-[\w-]+):/gm
const llms = await Bun.file(join(root, 'llms.txt')).text()
const docs = (await readdir(join(root, 'llms'))).filter(name => name.endsWith('.md')).sort()
const LISTED = /^- \[[^\]]+\]\(llms\/([\w-]+\.md)\): \S/gm
const KAY_BLOCK = /```kay\n([\s\S]*?)```/g
const pagesDir = join(root, 'docs/src/content/docs')
const pageBlocks = (await Promise.all([...new Bun.Glob('**/*.md').scanSync(pagesDir)].toSorted().map(async file => [...(await Bun.file(join(pagesDir, file)).text()).matchAll(KAY_BLOCK)].map((match, index) => [`${file} #${index + 1}`, match[1]!] as const)))).flat()
const CARD_LINK = /ModuleCard\([^)]*\bhref="([^"]+)"/g
const FRONTMATTER_PATH = /^path: (.+)$/m
const FENCE = /^```[\s\S]+?^```/gm
const FRONTMATTER = /^---\n[\s\S]*?\n---\n/
const BLANK_LINE = /\n\s*\n/
const LIST_ITEM = /\n(?=\s*(?:[-*]|\d+\.) )/
const NOT_PROSE = /^[|<#]/
const PARAGRAPH_CAP = 500

describe('llms.txt', () => {
  it('stays an index an agent reads whole, listing every doc of llms/ once', () => {
    const listed = [...llms.matchAll(LISTED)].map(match => match[1]!)

    expect(llms.length).toBeLessThan(10_000)
    expect(listed.toSorted()).toEqual(docs)
    expect(new Set(listed).size).toBe(listed.length)
  })
})

describe('the documentation site\'s pages', () => {
  it.each(pageBlocks)('%s compiles cleanly and is formatted', (_name, source) => {
    const filename = source.startsWith('--- server') ? 'src/routes/example.kay' : 'src/example.kay'
    const { diagnostics } = compileKay(source, filename)

    expect(diagnostics.map(diagnostic => formatDiagnostic(source, filename, diagnostic))).toEqual([])
    expect(formatKay(source).code).toBe(source)
  })
})

describe('the documentation site', () => {
  it('serves llms.txt and each doc it lists as the full reference under /llms, links between them made links between pages', async () => {
    const pages = await loadReference()

    expect(pages.map(page => page.slug)).toEqual(['overview', ...[...llms.matchAll(LISTED)].map(match => match[1]!.replace('.md', ''))])
    expect(pages.find(page => page.slug === 'server')!.data.title).toBe('Locals, sessions and guards')
    expect(pages.flatMap(page => [...page.body.matchAll(LINK)].filter(([, path]) => path !== undefined))).toEqual([])
    expect(pages.find(page => page.slug === 'project')!.body).toContain('](/llms/server#locals)')
  })

  it('gives each library its full reference, and each kayjs-ui component a page with its usage and the props it declares', async () => {
    const components = await loadComponents()
    const button = components.find(component => component.slug === 'button')!
    const props = new Map(button.data.props.map(prop => [prop.name, prop]))
    const libraries = await loadLibraries()
    const ui = libraries.find(library => library.slug === 'kayjs-ui')!

    expect(libraries.filter(library => library.data.source === 'llms.txt').map(library => library.slug)).toEqual(['kayjs-ai', 'kayjs-auth', 'kayjs-cms', 'kayjs-mail', 'kayjs-ui'])
    // The topic files an index lists are pages of their own, the links between them links between pages.
    expect(libraries.find(library => library.slug === 'kayjs-auth-setup')!.data).toMatchObject({ library: 'kayjs-auth', source: 'llms/setup.md' })
    expect(libraries.find(library => library.slug === 'kayjs-auth')!.body).toContain('](/llms/kayjs-auth-setup)')
    expect(libraries.flatMap(library => [...library.body.matchAll(LINK)].filter(([, path]) => path !== undefined))).toEqual([])
    expect(ui.data.version).toBe((await Bun.file(join(root, 'node_modules/@kaynooo/kayjs-ui/package.json')).json() as { version: string }).version)
    // FormDialog posts to an action, which the static site cannot serve, so its page shows code alone.
    expect(components.filter(component => component.data.description === '').map(component => component.slug)).toEqual([])
    expect(components.filter(component => !component.body.includes('<Demo name=')).map(component => component.slug)).toEqual(['form-dialog'])
    expect(props.get('href')).toMatchObject({ type: 'string', optional: true })
    expect(props.get('variant')).toMatchObject({ type: '"solid" | "ghost" | "inline"', default: '\'solid\'' })
    expect(props.has('disabled')).toBe(false)
    expect(components.find(component => component.slug === 'table')!.data.props.find(prop => prop.name === 'onSort')!.type).toBe('(sort: SortState) => void')
  })

  it('resolves every internal link and anchor of llms/, the docs content, the home page and llms.txt to a page the site serves', async () => {
    const broken = await brokenLinks()

    expect(broken).toEqual([])
  })

  // The docs site is read by people: plain prose, one idea per paragraph, as llms/ stays dense for agents.
  it('keeps every paragraph and list item of the docs site under 500 characters', async () => {
    const contentDir = join(root, 'docs/src/content')
    const long: string[] = []

    for (const file of new Bun.Glob('{docs,ui}/**/*.md').scanSync(contentDir)) {
      const body = (await Bun.file(join(contentDir, file)).text()).replace(FRONTMATTER, '').replace(FENCE, '')

      for (const block of body.split(BLANK_LINE).flatMap(paragraph => paragraph.split(LIST_ITEM))) {
        const text = block.trim()

        if (text.length > PARAGRAPH_CAP && !NOT_PROSE.test(text))
          long.push(`${file}: ${text.length} characters, "${text.slice(0, 60)}"`)
      }
    }

    expect(long).toEqual([])
  })

  it('lists every lint in the checks reference', async () => {
    const reference = await Bun.file(join(pagesDir, 'reference/checks.md')).text()

    expect(Object.keys(LINTS).filter(name => !reference.includes(`| \`${name}\` |`))).toEqual([])
  })

  it('gives each card of the home page a link of its own', async () => {
    const home = await Bun.file(join(root, 'docs/src/routes/(docs)/index.kay')).text()
    const cards = [...home.matchAll(CARD_LINK)].map(match => match[1]!)

    expect(cards.length).toBeGreaterThan(5)
    expect(new Set(cards).size).toBe(cards.length)
  })

  it('leads an agent reading the home page, or guessing /docs, to the docs', async () => {
    const home = await Bun.file(join(root, 'docs/src/routes/(docs)/index.kay')).text()
    const { default: config } = await import('../docs/kay.config')

    expect(config.redirects?.['/docs']).toBe('/getting-started/introduction')
    expect(home).toContain('link(rel="alternate" type="text/plain" href="/llms.txt"')
    expect(home).toContain('for group of groups')
  })

  it('shows on the home page the steps Installation gives', async () => {
    const home = await Bun.file(join(root, 'docs/src/routes/(docs)/index.kay')).text()
    const installation = await Bun.file(join(root, 'docs/src/content/docs/getting-started/installation.md')).text()
    const steps = ['REGISTRY', 'CREATE'].map(name => home.match(new RegExp(`const ${name} = \`([^\`]+)\``))?.[1])

    expect(steps).toEqual([expect.any(String), expect.any(String)])

    for (const step of steps)
      expect(installation).toContain(`\n${step}\n\`\`\``)
  })

  it('reads a FileTree\'s outline, nesting each entry under the folder above it, its link and its note apart', () => {
    expect(fileTree(`
      src/
        [[slug].kay](#dynamic-routes)  /blog/:slug
        [x].kay  see [a](b)
      kay.config.ts
    `)).toEqual([
      { name: 'src/', href: undefined, note: undefined, children: [
        { name: '[slug].kay', href: '#dynamic-routes', note: '/blog/:slug', children: [] },
        { name: '[x].kay', href: undefined, note: 'see [a](b)', children: [] },
      ] },
      { name: 'kay.config.ts', href: undefined, note: undefined, children: [] },
    ])
    expect(() => fileTree('\n  \n')).toThrow('FileTree has no file to draw')
    expect(() => fileTree('src/ the sources')).toThrow('FileTree cannot read the line "src/ the sources"')
  })

  it('draws the Structure part\'s tree from its pages\' paths, each folder above them once, in the order first met', () => {
    expect(pathTree([
      { path: 'src/routes/', href: '/structure/routes' },
      { path: 'src/routes/_layout.kay', href: '/structure/layout' },
      { path: 'src/server.ts', href: '/structure/server' },
      { path: 'kay.config.ts', href: '/structure/kay-config' },
    ])).toEqual([
      { name: 'src/', children: [
        { name: 'routes/', href: '/structure/routes', children: [{ name: '_layout.kay', href: '/structure/layout', children: [] }] },
        { name: 'server.ts', href: '/structure/server', children: [] },
      ] },
      { name: 'kay.config.ts', href: '/structure/kay-config', children: [] },
    ])
    expect(() => pathTree([{ path: 'src/', href: '/a' }, { path: 'src/', href: '/b' }])).toThrow('Two pages are about src/')
  })

  it('gives every Structure page a path, together drawing each file and folder of a kay project', async () => {
    const folder = join(root, 'docs/src/content/docs/structure')
    const paths = await Promise.all((await readdir(folder)).map(async name => FRONTMATTER_PATH.exec(await Bun.file(join(folder, name)).text())?.[1]))

    expect(paths).not.toContain(undefined)
    expect(paths).toEqual(expect.arrayContaining(['src/routes/', 'src/routes/_layout.kay', 'src/routes/_404.kay', 'src/routes/[param].kay', 'src/routes/[[optional]].kay', 'src/routes/(group)/', 'src/routes/[param=matcher].kay', 'src/routes/feed.xml.ts', 'src/components/', 'src/api/', 'src/content/', 'src/content.config.ts', 'src/server.ts', 'public/', 'kay.config.ts', 'tsconfig.json', '.kay/']))
  })

  it('reads each page in its part, the sidebar listing only that part\'s pages', () => {
    expect(['/', '/getting-started/introduction', '/libraries/kayjs-ui', '/structure/routes', '/ui/button', '/llms', '/llms/routing', '/llmsx'].map(partOf))
      .toEqual(['docs', 'docs', 'docs', 'structure', 'ui', 'agents', 'agents', 'docs'])
  })

  it('puts the theme a visitor picked on the page from the head, reading what kay kept, and shows the tokens an app sets for it', () => {
    const paint = (kept: Record<string, unknown>) => {
      const html = { dataset: {} as Record<string, string> }
      const storage = { getItem: (key: string) => key in kept ? sendValue(kept[key]) : null }
      // eslint-disable-next-line no-new-func -- the head runs the script as a string, and so does the test.
      const run = new Function('localStorage', 'document', THEME_SCRIPT) as (storage: { getItem: (key: string) => string | null }, page: { documentElement: typeof html }) => void

      run(storage, { documentElement: html })

      return html.dataset
    }

    expect(paint({ 'kay-docs-scheme': 'dark', 'kay-docs-palette': 'nord' })).toEqual({ theme: 'dark', palette: 'nord' })
    expect(paint({ 'kay-docs-scheme': 'system', 'kay-docs-palette': 'kay' })).toEqual({})
    expect(paint({ 'kay-docs-scheme': 'neon', 'kay-docs-palette': 'pink' })).toEqual({})
    expect(paint({})).toEqual({})

    const nord = PALETTES.find(one => one.value === 'nord')!.colours

    expect(themeCss('nord')).toStartWith(`@theme {\n  --color-kui-mantle: light-dark(${nord.mantle![0]}, ${nord.mantle![1]});\n`)
    expect(themeCss('nord')).not.toContain('shiki')
  })

  it('switches the theme on the page as the visitor picks it, the docs\' own palette being the root\'s', () => {
    const html = { dataset: {} as Record<string, string> }
    const globals = globalThis as unknown as Record<string, unknown>
    const before = globals.document

    globals.document = { documentElement: html }

    try {
      pickTheme({ scheme: 'dark', palette: 'gruvbox' })
      pickTheme({ palette: 'nord' })

      expect(html.dataset).toEqual({ theme: 'dark', palette: 'nord' })
      expect([scheme(), palette()]).toEqual(['dark', 'nord'])

      pickTheme({ scheme: 'system', palette: 'kay' })

      expect(html.dataset).toEqual({})
    }
    finally {
      globals.document = before
    }
  })
})

// WCAG's contrast ratio between two `#rrggbb` colours.
function contrast(a: string, b: string): number {
  const luminance = (hex: string) => {
    const [r, g, b] = [1, 3, 5].map(at => Number.parseInt(hex.slice(at, at + 2), 16) / 255).map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4) as [number, number, number]

    return 0.2126 * r + 0.7152 * g + 0.0722 * b
  }
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number]

  return (light + 0.05) / (dark + 0.05)
}

describe('the documentation\'s colours', () => {
  const GROUNDS = ['mantle', 'canvas', 'surface0', 'surface1', 'fill-hover']
  const TEXT = ['text', 'subtext0', 'overlay1', 'accent', 'error', 'success', 'warning', 'info']
  const SYNTAX = Object.keys(PALETTES[0]!.colours).filter(name => name.startsWith('syntax-'))
  // Each pair under its minimum, as `palette: colour on ground (scheme): ratio`.
  const failing = (pairs: [string, string][], least: number) => PALETTES.flatMap(({ value, colours }) => pairs.flatMap(([fg, ground]) => [0, 1].map(scheme => [`${value}: ${fg} on ${ground} (${scheme === 0 ? 'light' : 'dark'})`, contrast(colours[fg]![scheme]!, colours[ground]![scheme]!)] as const)))
    .filter(([, ratio]) => ratio < least)
    .map(([pair, ratio]) => `${pair}: ${ratio.toFixed(2)}`)

  it('offers each palette in the picker, each setting every colour, as palettes.css holds them', async () => {
    expect(PALETTES.map(one => one.value)).toEqual(THEMES.map(one => one.value))

    for (const { colours } of PALETTES)
      expect(Object.keys(colours)).toEqual(Object.keys(PALETTES[0]!.colours))

    expect(await Bun.file(join(root, 'docs/src/palettes.css')).text()).toBe(paletteStylesheet())
  })

  it('reads text at 4.5:1 and field borders at 3:1 on every ground, in both schemes of every palette', () => {
    expect(failing(TEXT.flatMap(text => GROUNDS.map(ground => [text, ground] as [string, string])), 4.5)).toEqual([])
    expect(failing(GROUNDS.map(ground => ['field-border', ground]), 3)).toEqual([])
    expect(failing(['accent', 'accent-hi', 'error', 'success', 'warning', 'info', 'subtext0'].map(fill => ['on-accent', fill] as [string, string]), 4.5)).toEqual([])
  })

  it('highlights code in the palette\'s syntax colours, each at 4.5:1 on the code\'s ground', async () => {
    const { highlight } = await import('../docs/src/highlight')
    const styles = await Bun.file(join(root, 'docs/src/styles.css')).text()
    const samples = [
      ['typescript', '// A comment\nimport { s } from \'kay\'\nexport const page = { query: s.Object({ q: s.Optional(s.String()) }) }\nconst n: number = 1 + Number(\'2\') as number\nclass A extends B { #x = /re+/g; get y() { return `t${this.#x}` } }'],
      ['kay', '---\nconst { title } = props<{ title: string }>()\n---\n// A note\nh1.title(data-x="1") {title}\nif title\n  p Hello #[b there]\nfor item of items key={item.id}\n  a(href={item.url}) {item.name}'],
      ['bash', '# install\nbun add kay && echo "done" $HOME --flag'],
      ['json', '{ "name": "app", "version": 1, "private": true, "list": [null] }'],
      ['css', '/* note */\n.a:hover > b { color: #fff !important; margin: 1rem calc(2px + 1em); }\n@media (width > 30rem) { :root { --x: 1 } }'],
      ['html', '<!-- note -->\n<a href="/x" class="y">Link &amp; more</a>'],
      ['diff', '- removed\n+ added\n@@ -1 +1 @@'],
      ['toml', '# note\n[server]\nport = 3000\nname = "x"'],
    ]
    const used = new Set((await Promise.all(samples.map(async ([language, code]) => highlight(code!, language)))).flatMap(html => [...html.matchAll(SHIKI_COLOUR)].map(match => match[1]!)))
    const set = new Set([...SYNTAX.map(name => `--shiki-token-${name.slice(7)}`), ...[...styles.matchAll(SHIKI_ALIAS)].map(match => match[1]!)])

    expect([...used].filter(name => !set.has(name))).toEqual([])
    expect(failing(SYNTAX.map(name => [name, 'mantle']), 4.5)).toEqual([])
  })
})

const FILES: Record<string, string> = { '/app.css': 'a { color: red }', '/logo.svg': '<svg></svg>', '/favicon.ico': 'icon'.repeat(500), '/favicon.svg': '<svg viewBox="0 0 32 32"/>', '/entry.js': 'export {}', '/apple-touch-icon.png': 'touch' }
const WEIGHT = /This page: ([\d.]+) KB\./
let dir: string

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'kay-page-weight-'))
  await Promise.all(Object.entries(FILES).map(async ([url, text]) => Bun.write(join(dir, url), text)))
})

afterAll(async () => rm(dir, { recursive: true, force: true }))

const brotli = (text: string) => brotliCompressSync(text).length

async function transform(head: string, body = ''): Promise<string> {
  const html = `<html><head><link rel="stylesheet" href="/app.css"><link rel="icon" href="/favicon.ico"><link rel="apple-touch-icon" href="/apple-touch-icon.png">${head}</head><body>${body}<footer><span data-page-weight></span></footer></body></html>`

  return pageWeight.transformPage!({ path: '/', locale: 'en', html, file: async url => url in FILES ? join(dir, url) : undefined })
}

describe('the docs footer\'s page weight', () => {
  it('counts the page and each file a first visit fetches once, as served: text brotli, an icon as it is', async () => {
    const html = await transform('<link rel="modulepreload" href="/entry.js"><script type="module" src="/entry.js"></script>', '<img src="/logo.svg"><img src="/logo.svg"><iframe src="/elsewhere" loading="lazy"></iframe>')
    const linked = brotli(FILES['/app.css']!) + brotli(FILES['/entry.js']!) + brotli(FILES['/logo.svg']!) + FILES['/favicon.ico']!.length

    expect(Number(WEIGHT.exec(html)?.[1])).toBe(Number(((brotli(html) + linked) / 1024).toFixed(1)))
  })

  it('counts the SVG icon alone when the page links one, as a browser drawing it fetches no other', async () => {
    const html = await transform('<link rel="icon" href="/favicon.svg" type="image/svg+xml">')
    const linked = brotli(FILES['/app.css']!) + brotli(FILES['/favicon.svg']!)

    expect(Number(WEIGHT.exec(html)?.[1])).toBe(Number(((brotli(html) + linked) / 1024).toFixed(1)))
  })

  it('leaves a page without the footer as it is', async () => {
    const page: RenderedPage = { path: '/404', locale: 'en', html: '<p>Nothing here</p>', file: async () => undefined }

    expect(await pageWeight.transformPage!(page)).toBe(page.html)
  })
})
