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
#main.card.md:flex.w-1/2(class="[&>p]:mt-2")
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
  schema: s.Object({ title: s.String({ maxLength: 80 }), date: s.Date(), tags: s.Array(s.String(), { default: [] }), draft: s.Optional(s.Boolean()), kind: s.Union([s.Literal('note'), s.Literal('post')]), cover: s.String(), views: s.Integer({ minimum: 0 }), slug: /* kay migrate: .transform() has no \`t\` counterpart kay migrate knows */ z.string().transform(value => value.toLowerCase()) }),
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

    expect(report.written.toSorted()).toEqual(['.gitignore', '.npmrc', 'AGENTS.md', 'kay.config.ts', 'package.json', 'src/layouts/layout.kay', 'src/routes/index.kay', 'src/server.ts', 'tsconfig.json'])
    expect(report.copied.toSorted()).toEqual(['public/.well-known/security.txt', 'public/favicon.svg', 'src/styles/global.css'])
    expect(await Bun.file(join(out, 'src/routes/index.kay')).text()).toBe('--- server\nimport Layout from \'../layouts/layout.kay\'\n---\nLayout\n  h1 Accueil\n')
    expect(await Bun.file(join(out, 'kay.config.ts')).text()).toBe('import tailwind from \'bun-plugin-tailwind\'\nimport { defineConfig } from \'kay/server\'\n\nexport default defineConfig({\n  lang: \'fr\',\n  site: \'https://example.com\',\n  base: \'/docs\',\n  plugins: [tailwind],\n})\n')
    expect(await Bun.file(join(out, 'tsconfig.json')).json()).toEqual({ extends: 'kay/tsconfig.json', compilerOptions: { paths: { '@/*': ['./src/*'] } } })
    expect(packageJson.scripts.dev).toBe('kay dev')
    expect(packageJson.dependencies).toEqual({ 'date-fns': '^4.1.0', 'elysia': expect.any(String), 'kay': '^1.0.0' })
    expect(Object.keys(packageJson.devDependencies)).toEqual(['@types/bun', 'bun-plugin-tailwind', 'tailwindcss'])
    expect(report.notes).toEqual([])
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
})
