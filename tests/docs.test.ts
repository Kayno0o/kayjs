import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'
import { fileTree, pathTree } from '../docs/src/file-tree'
import { loadComponents, loadLibraries } from '../docs/src/libraries'
import { loadReference } from '../docs/src/reference'
import { partOf } from '../docs/src/sections'
import { accent, ACCENTS, pickTheme, scheme, THEME_SCRIPT, themeCss } from '../docs/src/theme'
import { check } from '../src/check'
import { renderMarkdown } from '../src/content/markdown'
import { sendValue } from '../src/runtime/send'

const root = join(import.meta.dir, '..')
const llms = await Bun.file(join(root, 'llms.txt')).text()
const docs = (await readdir(join(root, 'llms'))).filter(name => name.endsWith('.md')).sort()
const LISTED = /^- \[[^\]]+\]\(llms\/([\w-]+\.md)\): \S/gm
// A link to a page of the site in Markdown or a ReadMore, anchor left out: `](/essentials/routing#layouts)`, `href="/llms/server"`.
const SITE_LINK = /(?:\]\(|href=")(\/[\w/-]*?)\/?(?:#[\w-]*)?[)"]/g
// Code blocks and spans, whose links are examples rather than links of the site.
const CODE = /```[\s\S]*?```|`[^`\n]*`/g
const LINK = /\]\(((?:llms\/)?[\w-]+\.md)?(#[\w-]+)?\)/g
const CARD_LINK = /ModuleCard\([^)]*\bhref="([^"]+)"/g
const SECTION_LINK = /href[=:] ?["'](\/[\w/-]+)#([\w-]+)["']/g

describe('llms.txt', () => {
  it('stays an index an agent reads whole, listing every doc of llms/ once', () => {
    const listed = [...llms.matchAll(LISTED)].map(match => match[1]!)

    expect(llms.length).toBeLessThan(10_000)
    expect(listed.toSorted()).toEqual(docs)
    expect(new Set(listed).size).toBe(listed.length)
  })

  it('links only to docs and headings that exist', async () => {
    const files = ['llms.txt', ...docs.map(name => `llms/${name}`)]
    const ids = new Map(await Promise.all(files.map(async file => [file, new Set((await renderMarkdown(await Bun.file(join(root, file)).text())).headings.map(heading => heading.id))] as const)))
    const broken: string[] = []

    for (const file of files) {
      for (const [link, path, anchor] of (await Bun.file(join(root, file)).text()).matchAll(LINK)) {
        const target = path === undefined ? file : file === 'llms.txt' ? path : `llms/${path}`

        if (!ids.has(target) || (anchor !== undefined && !ids.get(target)!.has(anchor.slice(1))))
          broken.push(`${file}: ${link}`)
      }
    }

    expect(broken).toEqual([])
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

    expect(libraries.map(library => library.slug)).toEqual(['kayjs-auth', 'kayjs-cms', 'kayjs-mail', 'kayjs-ui'])
    expect(ui.data.version).toBe((await Bun.file(join(root, 'node_modules/@kaynooo/kayjs-ui/package.json')).json() as { version: string }).version)
    // FormDialog posts to an action, which the static site cannot serve, so its page shows code alone.
    expect(components.filter(component => component.data.description === '').map(component => component.slug)).toEqual([])
    expect(components.filter(component => !component.body.includes('<Demo name=')).map(component => component.slug)).toEqual(['form-dialog'])
    expect(props.get('href')).toMatchObject({ type: 'string', optional: true })
    expect(props.get('variant')).toMatchObject({ type: '"accent" | "danger" | "default"', default: '\'default\'' })
    expect(props.has('disabled')).toBe(false)
    expect(components.find(component => component.slug === 'table')!.data.props.find(prop => prop.name === 'onSort')!.type).toBe('(sort: SortState) => void')
  })

  it('links only to pages the site serves', async () => {
    const docsRoot = join(root, 'docs/src/content')
    const files = [...new Bun.Glob('{docs/*/*,ui/*}.md').scanSync(docsRoot)]
    const pages = new Set([
      '/',
      '/llms',
      ...files.filter(file => file.startsWith('docs/')).map(file => `/${file.slice('docs/'.length, -'.md'.length)}`),
      ...(await loadComponents()).map(component => `/ui/${component.slug}`),
      ...(await loadReference()).map(topic => `/llms/${topic.slug}`),
      ...(await loadLibraries()).map(library => `/llms/${library.slug}`),
    ])
    const broken: string[] = []

    for (const file of files) {
      for (const [, path] of (await Bun.file(join(docsRoot, file)).text()).replace(CODE, '').matchAll(SITE_LINK)) {
        if (!pages.has(path!))
          broken.push(`${file}: ${path}`)
      }
    }

    expect(broken).toEqual([])
  })

  it('links each card of the home page to its own page or section, each anchor a heading of that page', async () => {
    const home = await Bun.file(join(root, 'docs/src/routes/(docs)/index.kay')).text()
    const cards = [...home.matchAll(CARD_LINK)].map(match => match[1]!)
    const broken: string[] = []

    for (const [link, path, anchor] of home.matchAll(SECTION_LINK)) {
      const source = Bun.file(join(root, 'docs/src/content/docs', `${path}.md`))
      const ids = await source.exists() ? (await renderMarkdown(await source.text())).headings.map(heading => heading.id) : []

      if (!ids.includes(anchor!))
        broken.push(link)
    }

    expect(cards.length).toBeGreaterThan(5)
    expect(new Set(cards).size).toBe(cards.length)
    expect(broken).toEqual([])
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

  it('reads each page in its part, the sidebar listing only that part\'s pages', () => {
    expect(['/', '/getting-started/introduction', '/libraries/kayjs-ui', '/structure/routes', '/ui/button', '/llms', '/llms/routing', '/llmsx'].map(partOf))
      .toEqual(['docs', 'docs', 'docs', 'structure', 'ui', 'agents', 'agents', 'docs'])
  })

  it('puts the theme a visitor picked on the page from the head, reading what kay kept, and shows the tokens an app sets for it', () => {
    const paint = (kept: Record<string, unknown>) => {
      const html = { dataset: {} as Record<string, string>, style: { set: {} as Record<string, string>, setProperty(name: string, value: string) {
        this.set[name] = value
      } } }
      const storage = { getItem: (key: string) => key in kept ? sendValue(kept[key]) : null }
      // eslint-disable-next-line no-new-func -- the head runs the script as a string, and so does the test.
      const run = new Function('localStorage', 'document', THEME_SCRIPT) as (storage: { getItem: (key: string) => string | null }, page: { documentElement: typeof html }) => void

      run(storage, { documentElement: html })

      return { theme: html.dataset.theme, tokens: html.style.set }
    }
    const blue = ACCENTS.find(one => one.value === 'blue')!.tokens

    expect(paint({ 'kay-docs-scheme': 'dark', 'kay-docs-accent': 'blue' })).toEqual({ theme: 'dark', tokens: blue })
    expect(paint({ 'kay-docs-scheme': 'system', 'kay-docs-accent': 'yellow' })).toEqual({ theme: undefined, tokens: {} })
    expect(paint({ 'kay-docs-scheme': 'neon', 'kay-docs-accent': 'pink' })).toEqual({ theme: undefined, tokens: {} })
    expect(paint({})).toEqual({ theme: undefined, tokens: {} })
    expect(themeCss('blue')).toBe(`@theme {\n  --color-kui-accent: ${blue['--color-kui-accent']};\n  --color-kui-accent-hi: ${blue['--color-kui-accent-hi']};\n  --color-kui-on-accent: ${blue['--color-kui-on-accent']};\n}`)
  })

  it('switches the theme on the page as the visitor picks it, taking the last accent\'s tokens off, the docs\' own accent being site.css\'s', async () => {
    const set = new Map<string, string>()
    const html = { dataset: {} as Record<string, string>, style: { setProperty: (name: string, value: string) => set.set(name, value), removeProperty: (name: string) => set.delete(name) } }
    const globals = globalThis as unknown as Record<string, unknown>
    const before = globals.document

    globals.document = { documentElement: html }

    try {
      pickTheme({ scheme: 'dark', accent: 'violet' })
      pickTheme({ accent: 'blue' })

      expect(html.dataset.theme).toBe('dark')
      expect(Object.fromEntries(set)).toEqual(ACCENTS.find(one => one.value === 'blue')!.tokens)
      expect([scheme(), accent()]).toEqual(['dark', 'blue'])

      pickTheme({ scheme: 'system', accent: 'yellow' })

      expect(html.dataset.theme).toBeUndefined()
      expect(set.size).toBe(0)
    }
    finally {
      globals.document = before
    }

    const site = await Bun.file(join(root, 'docs/src/site.css')).text()

    for (const [name, value] of Object.entries(ACCENTS[0]!.tokens))
      expect(site).toContain(`${name}: ${value};`)
  })

  it('passes kay check, and so does the tutorial\'s example app', async () => {
    expect(await check(join(root, 'docs'))).toEqual([])
    expect(await check(join(root, 'examples/reading-list'))).toEqual([])
  }, 60_000)
})
