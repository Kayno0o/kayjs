import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, describe, expect, it } from 'bun:test'
import { formatKay } from '../src/compiler/format'
import { migrateAstro } from '../src/migrate/astro'
import { migrateContentConfig } from '../src/migrate/content'
import { migrateAstroProject } from '../src/migrate/project'

const page = (source: string) => migrateAstro(source, { role: 'page', rewriteImport: () => undefined })
const component = (source: string) => migrateAstro(source, { role: 'component', rewriteImport: specifier => specifier.replace('Card.astro', 'card.kay') })
const dirs: string[] = []

// A note's message up to its advice.
function lead(message: string): string {
  const end = message.indexOf(':')

  return end === -1 ? message : message.slice(0, end)
}

afterAll(async () => {
  await Promise.all(dirs.map(async dir => rm(dir, { recursive: true, force: true })))
})

describe('kay migrate astro', () => {
  it('turns the frontmatter into a fence, Astro.props into props and a page\'s request into ctx', () => {
    const { code, notes } = page(`---
import type { ImageMetadata } from 'astro'
import { Image } from 'astro:assets'
import photo from '../photo.jpg'

interface Props { image: ImageMetadata }

const { image } = Astro.props
if (!Astro.cookies.get('session'))
  return Astro.redirect('/login')
const path = Astro.url.pathname
---
<Image src={photo} alt="A photo" />
<p>{path} {image}</p>
`)

    expect(code).toBe(`--- server
import photo from '../photo.jpg'

interface Props { image: string }

const { image } = props<Props>()
if (!ctx.cookies.get('session'))
  ctx.redirect('/login')
const path = ctx.url.pathname
---
img(src={photo} alt="A photo")
p {path} {image}
`)
    expect(notes).toEqual([])
  })

  it('lists what a component reads of the request and awaits, which it cannot in kay', () => {
    const { code, notes } = component(`---
import Card from './Card.astro'
const path = Astro.url.pathname
const rows = await load()
---
<Card title={path} rows={rows} />
`)

    expect(code).toStartWith(`---\nimport Card from './card.kay'\n`)
    expect(notes.map(note => [note.line, lead(note.message)])).toEqual([
      [3, 'Astro.url has no kay counterpart in a component, which has no request'],
      [4, 'a component renders synchronously'],
    ])
  })

  it('writes classes as the shorthand, control flow as if and for, and slots as kay\'s', () => {
    const { code, notes } = component(`---
const { items, open } = Astro.props
---
<div class="card md:flex w-1/2 [&>p]:mt-2" id="main">
  {open && <p class:list={['note', { open }]}>Open</p>}
  {items.length > 0 ? <ul>{items.map((item, i) => <li key={item.id}>{i}: {item.name}</li>)}</ul> : <p>None</p>}
  <p>Read <a href="/docs">the docs</a> first.</p>
  <slot />
  <slot name="footer" />
  {items.map(({ name }) => <span>{name}</span>)}
</div>
`)

    expect(code).toBe(`---
const { items, open } = props<Record<string, unknown>>()
---
#main.card.md:flex.w-1/2.[&>p]:mt-2
  if open
    p(class={['note', { open }]}) Open
  if items.length > 0
    ul
      for item, i of items key={item.id}
        li {i}: {item.name}
  else
    p None
  p Read #[a(href="/docs") the docs] first.
  slot
  | {footer}
  // kay migrate: \`.map\` with a destructured parameter, which \`for\` does not take: name the item and read its fields
    {items.map(({ name }) => <span>{name}</span>)}
`)
    expect(notes.map(note => note.line)).toEqual([2, 9, 10])
  })

  it('gives a layout\'s head to a head block and its body to the template', () => {
    const { code, notes, lang } = component(`---
const { title, data } = Astro.props
---
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <title>{title}</title>
    <script type="application/ld+json" set:html={JSON.stringify(data)} />
  </head>
  <body class="page">
    <!-- the page -->
    <main set:html={title} />
  </body>
</html>
`)

    expect(code).toBe(`---
import { trustHtml } from 'kay'
const { title, data } = props<Record<string, unknown>>()
---
head
  meta(charset="utf-8")
  title {title}
  script(type="application/ld+json") {JSON.stringify(data)}
// the page
main(innerHTML={trustHtml(title)})
`)
    expect(notes.map(note => lead(note.message))).toEqual(['Astro.props without a `Props` type', 'the attributes of body (class="page") have no place in kay, which writes body itself'])
    expect(lang).toEqual({ line: 5, value: 'en' })
  })

  it('fills a component\'s named slots from its children, and hydrates an island when Astro did', () => {
    const { code } = component(`---
import Card from './Card.astro'
import Counter from './Counter.astro'
---
<Card>
  <h2 slot="title">Hello</h2>
  <p>Body</p>
</Card>
<Counter client:visible />
<Counter client:load />
`)

    expect(code).toEndWith(`Card
  @title
    h2 Hello
  p Body
Counter(hydrate="visible")
Counter
`)
  })

  it('keeps an inline script and a style, and comments out a script Astro bundles', () => {
    const { code, notes } = component(`<script is:inline>console.log(\`\${1}\`)</script>
<script>import { go } from './go'; go()</script>
<style>p { color: red }</style>
`)

    expect(code).toBe(`script {\`console.log(\\\`\\\${1}\\\`)\`}
// kay migrate: a script Astro bundles
  <script>import { go } from './go'; go()</script>
style {\`p { color: red }\`}
`)
    expect(notes.map(note => note.line)).toEqual([2, 3])
  })

  it('types the attributes a component passes on as kay\'s JSX elements', () => {
    const { code } = component(`---
import type { HTMLAttributes } from 'astro/types'
interface Props extends HTMLAttributes<'svg'> { name: string }
type Link = HTMLAttributes<'a'>
const { name, ...rest } = Astro.props
---
<svg {...rest}>{name}</svg>
`)

    expect(code).toBe(`---
import type { JSX } from 'kay'
type SvgAttributes = JSX.IntrinsicElements['svg']

interface Props extends SvgAttributes { name: string }
type Link = JSX.IntrinsicElements['a']
const { name, ...rest } = props<Props>()
---
svg({...rest}) {name}
`)
  })

  it('writes a brace in text as text, and lists a handler written as a string and Astro.props read in the markup', () => {
    const { code, notes } = component(`<button onclick="go()">Set &#123;x&#125;</button>\n<p>{Astro.props.title}</p>\n`)

    expect(code).toBe(`button(onclick="go()") Set {'{'}x{'}'}\np {Astro.props.title}\n`)
    expect(notes.map(note => [note.line, lead(note.message)])).toEqual([[1, 'onclick holds code as text'], [2, 'Astro.props in the markup']])
  })

  it('writes output kay fmt leaves alone, and markup it cannot read commented out whole', () => {
    const { code, notes } = page(`<div>{items.filter(Boolean).length > 2 && <p>{(() => <b>x</b>)()}</p>}</div>\n`)

    expect(formatKay(code).code).toBe(code)
    expect(code).toContain('// kay migrate: an expression rendering markup another way')
    expect(notes).toHaveLength(1)
  })

  it('carries a content config over, its zod schema written in t', () => {
    const { code, notes } = migrateContentConfig(`import { defineCollection, z } from 'astro:content'
import { glob } from 'astro/loaders'

const blog = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/data/blog' }),
  schema: ({ image }) => z.object({
    title: z.string().max(80),
    date: z.date(),
    tags: z.array(z.string()).default([]),
    draft: z.boolean().optional(),
    kind: z.enum(['note', 'post']),
    cover: image(),
    views: z.number().int().min(0),
    slug: z.string().transform(value => value.toLowerCase()),
  }),
})

export const collections = { blog, authors: defineCollection({ schema: z.object({ name: z.string() }) }) }
`)

    expect(code).toBe(`import { s } from 'kay'
import { collection } from 'kay/content'

export const blog = collection('data/blog', {
  schema: s.Object({ title: s.String({ maxLength: 80 }), date: s.Date(), tags: s.Array(s.String(), { default: [] }), draft: s.Optional(s.Boolean()), kind: s.Union([s.Literal('note'), s.Literal('post')]), cover: s.String(), views: s.Integer({ minimum: 0 }), slug: /* kay migrate: .transform() has no \`s\` counterpart kay migrate knows */ z.string().transform(value => value.toLowerCase()) }),
})

export const authors = collection('content/authors', {
  schema: s.Object({ name: s.String() }),
})
`)
    expect(notes.map(note => note.line)).toEqual([14])
  })

  it('writes a project\'s pages as routes and its components in kebab-case, never over a file that exists', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kay-migrate-'))

    dirs.push(root)
    await Promise.all([
      Bun.write(join(root, 'package.json'), '{ "dependencies": { "astro": "^5.0.0" } }'),
      Bun.write(join(root, 'tsconfig.json'), '{ "compilerOptions": { "paths": { "~/*": ["./src/*"] } } }'),
      Bun.write(join(root, 'src/pages/index.astro'), '---\nimport Layout from \'../layouts/BaseLayout.astro\'\nimport Card from \'~/components/ProductCard.astro\'\n---\n<Layout><Card /></Layout>\n'),
      Bun.write(join(root, 'src/pages/404.astro'), '<h1>Not found</h1>\n'),
      Bun.write(join(root, 'src/pages/api/ping.ts'), 'export const GET = () => new Response(\'pong\')\n'),
      Bun.write(join(root, 'src/layouts/BaseLayout.astro'), '<main><slot /></main>\n'),
      Bun.write(join(root, 'src/components/ProductCard.astro'), '<article>Card</article>\n'),
      Bun.write(join(root, 'src/components/kept.kay'), 'p Mine\n'),
      Bun.write(join(root, 'src/components/Kept.astro'), '<p>Theirs</p>\n'),
    ])

    const report = await migrateAstroProject(root)

    expect(report.written.toSorted()).toEqual(['src/components/product-card.kay', 'src/layouts/base-layout.kay', 'src/routes/_404.kay', 'src/routes/index.kay'])
    expect(report.skipped).toEqual(['src/components/kept.kay'])
    expect(await Bun.file(join(root, 'src/routes/index.kay')).text()).toBe('--- server\nimport Layout from \'../layouts/base-layout.kay\'\nimport Card from \'~/components/product-card.kay\'\n---\nLayout\n  Card\n')
    expect(await Bun.file(join(root, 'src/components/kept.kay')).text()).toBe('p Mine\n')
    expect(report.notes.map(note => note.file)).toEqual(['package.json', 'src/pages/api/ping.ts', 'tsconfig.json'])
  })

  it('writes the kay project around the pages into an empty directory, with the Astro project\'s settings, packages and other files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kay-migrate-'))
    const out = join(await mkdtemp(join(tmpdir(), 'kay-migrate-')), 'site')

    dirs.push(root, dirname(out))
    await Promise.all([
      Bun.write(join(root, 'package.json'), JSON.stringify({ dependencies: { 'astro': '^5.0.0', '@astrojs/node': '^9.0.0', 'tailwindcss': '^4.1.0', '@tailwindcss/vite': '^4.1.0', 'date-fns': '^4.1.0' }, devDependencies: { 'prettier-plugin-astro': '^0.14.0' } })),
      Bun.write(join(root, 'astro.config.mjs'), 'import node from \'@astrojs/node\'\n\nexport default defineConfig({\n  site: \'https://example.com\',\n  base: \'/docs\',\n  output: \'server\',\n  adapter: node({ mode: \'standalone\' }),\n})\n'),
      Bun.write(join(root, 'tsconfig.json'), '{ "extends": "astro/tsconfigs/strict", "compilerOptions": { "baseUrl": ".", "paths": { "@/*": ["src/*"] } } }'),
      Bun.write(join(root, 'src/env.d.ts'), '/// <reference types="astro/client" />\n'),
      Bun.write(join(root, 'src/layouts/Layout.astro'), '---\nimport \'../styles/global.css\'\n---\n<html lang="fr">\n  <head><title>Site</title></head>\n  <body><slot /></body>\n</html>\n'),
      Bun.write(join(root, 'src/pages/index.astro'), '---\nimport Layout from \'../layouts/Layout.astro\'\n---\n<Layout><h1>Accueil</h1></Layout>\n'),
      Bun.write(join(root, 'src/styles/global.css'), '@import \'tailwindcss\';\n'),
      Bun.write(join(root, 'public/favicon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>\n'),
      Bun.write(join(root, 'public/.well-known/security.txt'), 'Contact: mailto:me@example.com\n'),
    ])

    const report = await migrateAstroProject(root, out, { kay: '^1.0.0' })
    const packageJson = await Bun.file(join(out, 'package.json')).json() as { scripts: Record<string, string>, dependencies: Record<string, string>, devDependencies: Record<string, string> }

    expect(report.written.toSorted()).toEqual(['.gitignore', '.npmrc', '.vscode/settings.json', 'AGENTS.md', 'kay.config.ts', 'package.json', 'src/layouts/layout.kay', 'src/routes/index.kay', 'src/server.ts', 'tsconfig.json'])
    expect(report.copied.toSorted()).toEqual(['public/.well-known/security.txt', 'public/favicon.svg', 'src/styles/global.css'])
    expect(await Bun.file(join(out, 'src/routes/index.kay')).text()).toBe('--- server\nimport Layout from \'../layouts/layout.kay\'\n---\nLayout\n  h1 Accueil\n')
    expect(await Bun.file(join(out, 'kay.config.ts')).text()).toBe('import tailwind from \'bun-plugin-tailwind\'\nimport { defineConfig } from \'kay/server\'\n\nexport default defineConfig({\n  lang: \'fr\',\n  site: \'https://example.com\',\n  base: \'/docs\',\n  plugins: [tailwind],\n})\n')
    expect(await Bun.file(join(out, 'tsconfig.json')).json()).toEqual({ extends: 'kay/tsconfig.json', compilerOptions: { paths: { '@/*': ['./src/*'] } } })
    // Its pages keep their own titles, so no `seo.name` ends them and AGENTS.md names none.
    expect(await Bun.file(join(out, 'AGENTS.md')).text()).not.toContain('seo.name')
    expect(packageJson.scripts.dev).toBe('kay dev')
    expect(packageJson.dependencies).toEqual({ 'date-fns': '^4.1.0', 'elysia': expect.any(String), 'kay': '^1.0.0' })
    expect(Object.keys(packageJson.devDependencies)).toEqual(['@types/bun', 'bun-plugin-tailwind', 'tailwindcss'])
    expect(report.notes).toEqual([])
  })

  it('keeps the tools the Astro project had, moves the files beside its pages into routes, and lists what it cannot carry', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kay-migrate-'))
    const out = join(root, 'kay')

    dirs.push(root)
    await Promise.all([
      Bun.write(join(root, 'package.json'), JSON.stringify({ devDependencies: { astro: '^5.0.0', eslint: '^9.0.0' } })),
      Bun.write(join(root, 'astro.config.mjs'), 'export default defineConfig({\n  site: process.env.SITE,\n})\n'),
      Bun.write(join(root, 'tsconfig.json'), '{ "compilerOptions": { "paths": { "@/*": ["./*"], "@config": ["src/config.ts"] } } }'),
      Bun.write(join(root, 'Dockerfile'), 'FROM node\n'),
      Bun.write(join(root, '.forgejo/workflows/deploy.yml'), 'on: push\n'),
      Bun.write(join(root, 'src/pages/index.astro'), '---\nimport hero from \'./hero.png\'\n---\n<img src={hero} alt="" />\n'),
      Bun.write(join(root, 'src/pages/hero.png'), 'png'),
      Bun.write(join(root, 'src/pages/about.md'), '# About\n'),
      Bun.write(join(root, 'src/pages/feed.xml.ts'), 'export const GET = () => new Response(\'\')\n'),
      Bun.write(join(root, 'src/styles/global.css'), '.theirs {}\n'),
      Bun.write(join(out, 'src/styles/global.css'), '.mine {}\n'),
    ])

    const report = await migrateAstroProject(root, out, { kay: '^1.0.0' })

    expect(report.written).toEqual(expect.arrayContaining(['eslint.config.ts', '.forgejo/workflows/pages.yml', 'Dockerfile', 'nginx.conf']))
    expect(report.copied).toEqual(['src/routes/hero.png'])
    expect(report.skipped).toEqual(['src/styles/global.css'])
    expect(await Bun.file(join(out, 'src/styles/global.css')).text()).toBe('.mine {}\n')
    expect(await Bun.file(join(out, 'tsconfig.json')).json()).toEqual({ extends: 'kay/tsconfig.json', compilerOptions: { paths: { '@/*': ['./*'], '@config': ['./src/config.ts'] } } })
    expect(report.notes.map(note => `${note.file}:${note.line} ${lead(note.message)}`)).toEqual(['astro.config.mjs:2 `site` is not a string kay migrate reads', 'src/pages/about.md:1 a Markdown page', 'src/pages/feed.xml.ts:1 an Astro endpoint'])
  })

  it('carries a static site\'s base under the one the Pages workflow sets, and lists Tailwind 3', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kay-migrate-'))
    const out = join(root, 'kay')

    dirs.push(root)
    await Promise.all([
      Bun.write(join(root, 'package.json'), JSON.stringify({ dependencies: { 'astro': '^4.0.0', '@astrojs/tailwind': '^5.0.0', 'tailwindcss': '^3.4.0' } })),
      Bun.write(join(root, 'astro.config.ts'), 'export default defineConfig({ base: \'/blog\' })\n'),
      Bun.write(join(root, 'src/pages/index.astro'), '<h1>Blog</h1>\n'),
    ])

    const report = await migrateAstroProject(root, out, { kay: '^1.0.0' })

    expect(await Bun.file(join(out, 'kay.config.ts')).text()).toContain('  base: process.env.SITE_BASE ?? \'/blog\',\n')
    expect(report.written).not.toContain('src/server.ts')
    expect(report.notes.map(note => lead(note.message))).toEqual(['Tailwind 3'])
  })

  it('translates or lists what an Astro project holds beyond Astro itself: a script after html, astro-icon, Astro.self, Vite\'s env and raw imports, Fontsource, UnoCSS, ESLint and a registry range', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kay-migrate-'))
    const out = join(root, 'kay')

    dirs.push(root)
    await Promise.all([
      Bun.write(join(root, 'package.json'), JSON.stringify({
        dependencies: { 'astro': '^4.0.0', 'astro-icon': '^1.1.0', '@fontsource/montserrat': '^5.0.0', '@kaynooo/utils': '^1.0.14', 'unocss': '^0.60.0' },
        devDependencies: { '@antfu/eslint-config': '^2.0.0', 'eslint': '^9.0.0', 'eslint-plugin-format': '^0.1.0', '@unocss/eslint-plugin': '^0.60.0', '@iconify-json/mdi': '^1.1.0' },
      }, null, 2)),
      Bun.write(join(root, 'astro.config.mjs'), 'import UnoCSS from \'unocss/astro\'\n\nexport default defineConfig({ integrations: [UnoCSS()] })\n'),
      Bun.write(join(root, 'uno.config.ts'), 'export default {}\n'),
      Bun.write(join(root, '.gitignore'), '# build\ndist/\n.astro/\nnode_modules\nworld\ndata\npublic/generated/\n'),
      Bun.write(join(root, 'public/svg/x.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>\n'),
      Bun.write(join(root, 'src/lib/rcon.ts'), 'export const host = import.meta.env.RCON_HOST\nimport logo from \'../../public/svg/x.svg?raw\'\n'),
      Bun.write(join(root, 'src/layouts/Layout.astro'), `---
import '@fontsource/montserrat/400.css'
import '@fontsource/montserrat/700.css'
import '@fontsource/montserrat/400-italic.css'
import { Icon } from 'astro-icon/components'
---
<html lang="en">
  <head>
    <title>Stats</title>
    <script is:inline src="https://unpkg.com/lib@1/dist/lib.js" defer></script>
  </head>
  <body>
    <button id="toggle"><Icon name="mdi:white-balance-sunny" class="size-5" /></button>
    <div class="text-red-5 group-even:(top-0 -translate-y-full)"><slot /></div>
  </body>
</html>
<script is:inline>
  document.getElementById('toggle').addEventListener('click', () => document.documentElement.classList.toggle('dark'))
</script>
`),
      Bun.write(join(root, 'src/components/Tree.astro'), `---
import separation from '../../public/svg/x.svg?raw'
const { item } = Astro.props
const host = import.meta.env.RCON_HOST
---
<div set:html={separation} />
<p>{host}</p>
{item.children.map(child => <Astro.self item={child} />)}
`),
      Bun.write(join(root, 'src/pages/index.astro'), '---\nimport Layout from \'../layouts/Layout.astro\'\n---\n<Layout><h1>Stats</h1></Layout>\n'),
    ])

    const report = await migrateAstroProject(root, out, { kay: '^1.0.0' })
    const layout = await Bun.file(join(out, 'src/layouts/layout.kay')).text()
    const packageJson = await Bun.file(join(out, 'package.json')).json() as { dependencies: Record<string, string>, devDependencies: Record<string, string> }
    const tree = await Bun.file(join(out, 'src/components/tree.kay')).text()

    // The script after html stays, the Fontsource imports leave for kay.config.ts, the icon is imported from its set and the script from another host needs no empty body.
    expect(layout).toContain('document.getElementById(\'toggle\')')
    expect(layout).toContain('import MdiWhiteBalanceSunny from \'~icons/mdi/white-balance-sunny\'')
    expect(layout).toContain('MdiWhiteBalanceSunny.size-5')
    expect(layout).toContain('script(src="https://unpkg.com/lib@1/dist/lib.js" defer)\n')
    expect(layout).not.toContain('fontsource')
    expect(layout).not.toContain('astro-icon')
    expect(await Bun.file(join(out, 'kay.config.ts')).text()).toContain('  fonts: [{ fontsource: \'@fontsource/montserrat\', weights: [400, 700] }, { fontsource: \'@fontsource/montserrat\', weights: [400], styles: [\'italic\'] }],\n')
    expect(tree).toContain('import separation from \'../../public/svg/x.svg\' with { type: \'text\' }')
    expect(tree).toContain('// kay migrate: Astro.self')
    expect(Object.keys(packageJson.dependencies)).toEqual(['@fontsource/montserrat', '@kaynooo/utils', 'elysia', 'kay'])
    expect(Object.keys(packageJson.devDependencies)).toEqual(['@iconify-json/mdi', '@kaynooo/eslint', '@types/bun'])
    expect(await Bun.file(join(out, '.gitignore')).text()).toEndWith('\n# From the Astro project\nworld\ndata\npublic/generated/\n')
    expect(report.notes.map(note => `${note.file}:${note.line} ${lead(note.message)}`)).toEqual([
      'package.json:6 `@kaynooo/utils@^1.0.14` is carried over, and the Forgejo registry the .npmrc names may hold no version in that range',
      'src/components/Tree.astro:3 Astro.props without a `Props` type',
      'src/components/Tree.astro:4 import.meta.env.RCON_HOST is Vite\'s',
      'src/components/Tree.astro:8 Astro.self, a component rendering itself, has no kay counterpart (import its own .kay file under a name and render that)',
      'src/layouts/Layout.astro:10 a script from unpkg.com',
      'src/lib/rcon.ts:1 import.meta.env is Vite\'s',
      'src/lib/rcon.ts:2 a `?raw` import is Vite\'s',
      'uno.config.ts:1 UnoCSS',
    ])
  })

  it('reads the Fontsource stylesheets it removes, and keeps and lists the ones it does not know', () => {
    const { code, fonts, notes } = component(`---
import '@fontsource/open-sans/latin-500-italic.css'
import '@fontsource/open-sans'
import '@fontsource-variable/inter/wght-italic.css'
import '@fontsource-variable/inter'
import '@fontsource/open-sans/600.css?inline'
import '@fontsource/open-sans/scss/mixins.scss'
---
<p>Hi</p>
`)

    expect(fonts.map(({ fontsource, weight, style }) => [fontsource, weight, style])).toEqual([['@fontsource/open-sans', 500, 'italic'], ['@fontsource/open-sans', 400, 'normal'], ['@fontsource-variable/inter', undefined, 'italic'], ['@fontsource-variable/inter', undefined, 'normal']])
    expect(code).toBe('---\nimport \'@fontsource/open-sans/600.css?inline\'\nimport \'@fontsource/open-sans/scss/mixins.scss\'\n---\np Hi\n')
    expect(notes.map(note => note.line)).toEqual([6, 7])
  })

  it('keeps what stands beside the html element, a define:vars script and an expression attribute listed', () => {
    const { code, notes } = component(`<!-- before -->
<html><body><p>a</p></body></html>
<script is:inline define:vars={{ a }} src={url}>document.x = 1</script>
`)

    expect(code).toBe('// before\np a\nscript {`document.x = 1`}\n')
    expect(notes.map(note => lead(note.message))).toEqual(['define', 'a script attribute holding an expression'])
  })
})
