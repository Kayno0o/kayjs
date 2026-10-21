import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import process from 'node:process'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { check } from '../src/check'
import { paginate } from '../src/content/paginate'

const CLI = resolve('src/cli.ts')

const TSCONFIG = JSON.stringify({ compilerOptions: { target: 'ESNext', jsx: 'preserve', jsxImportSource: 'kay', lib: ['ESNext', 'DOM'], rootDirs: ['.', '.kay/types'], module: 'Preserve', moduleResolution: 'bundler', strict: true, noEmit: true, skipLibCheck: true }, include: ['src', '.kay/types'] })

// A list page of two posts a page, the first at the list's own path.
const LIST = `--- server
import { paginate } from 'kay/content'
import { posts } from '../../content.config'

const blog = paginate(posts, 2)

export const page = { prerender: blog }

const list = await blog.page(ctx.params.page) ?? ctx.notFound()
---
ul
  for post of list.items key={post.slug}
    li {post.slug}
p.at {list.page}/{list.pages}
if list.prev
  a.prev(href={list.prev}) prev
if list.next
  a.next(href={list.next}) next
`

const CONTENT = `import { t } from 'elysia'
import { collection } from 'kay/content'

export const posts = collection('content/posts', { schema: t.Object({ title: t.String() }), localized: LOCALIZED })
`

const post = (title: string) => `---\ntitle: ${title}\n---\n${title}\n`

// Five posts, so three pages, the site mounted under /docs by a proxy that takes the base off what it forwards.
const PAGED: Record<string, string> = {
  'package.json': JSON.stringify({ name: 'app' }),
  'tsconfig.json': TSCONFIG,
  'kay.config.ts': 'import { defineConfig } from \'kay/server\'\n\nexport default defineConfig({ site: \'https://example.com\', base: \'/docs\' })\n',
  'src/content.config.ts': CONTENT.replace('LOCALIZED', 'false'),
  'src/routes/blog/[[page=integer]].kay': LIST,
  ...Object.fromEntries(['a', 'b', 'c', 'd', 'e'].map(slug => [`src/content/posts/${slug}.md`, post(slug)])),
}

// Four English posts, two pages; French translates one and adds one, so its list has five, three pages.
const LOCALIZED: Record<string, string> = {
  'package.json': JSON.stringify({ name: 'app' }),
  'tsconfig.json': TSCONFIG,
  'kay.config.ts': 'import { defineConfig } from \'kay/server\'\n\nexport default defineConfig({ site: \'https://example.com\', i18n: { locales: [\'en\', \'fr\'], defaultLocale: \'en\' } })\n',
  'src/messages/en.ts': 'import { defineMessages } from \'kay/i18n\'\n\nexport default defineMessages({})\n',
  'src/messages/fr.ts': 'import { defineMessages } from \'kay/i18n\'\n\nexport default defineMessages({})\n',
  'src/content.config.ts': CONTENT.replace('LOCALIZED', 'true'),
  'src/routes/blog/[[page=integer]].kay': LIST,
  ...Object.fromEntries(['a', 'b', 'c', 'd'].map(slug => [`src/content/posts/en/${slug}.md`, post(slug)])),
  'src/content/posts/fr/a.md': post('a'),
  'src/content/posts/fr/e.md': post('e'),
}

// URLs ending with a slash, and a list the sitemap names that prerenders nothing.
const SLASHED: Record<string, string> = {
  'package.json': JSON.stringify({ name: 'app' }),
  'tsconfig.json': TSCONFIG,
  'kay.config.ts': 'import { defineConfig } from \'kay/server\'\n\nexport default defineConfig({ site: \'https://example.com\', trailingSlash: \'always\' })\n',
  'src/content.config.ts': CONTENT.replace('LOCALIZED', 'false'),
  'src/routes/blog/[[page=integer]].kay': LIST.replace('prerender: blog', 'sitemap: blog'),
  ...Object.fromEntries(['a', 'b', 'c'].map(slug => [`src/content/posts/${slug}.md`, post(slug)])),
}

// What each path answers, its status and its body.
function serve(paths: string[]) {
  return `import { pages } from 'kay/server'

const app = await pages({ prebuilt: true })
const answers = {}

for (const path of ${JSON.stringify(paths)}) {
  const response = await app.handle(new Request(\`http://localhost\${path}\`))

  answers[path] = { status: response.status, body: await response.text() }
}

console.log(JSON.stringify(answers))
process.exit(0)
`
}

const projects = new Map<string, string>()

beforeAll(async () => {
  const base = join(import.meta.dir, '../node_modules/.cache')

  await mkdir(base, { recursive: true })

  for (const [name, files, paths] of [
    ['paged', PAGED, ['/blog', '/blog/2', '/blog/3', '/blog/4', '/blog/1', '/blog/0', '/blog/abc', '/sitemap.xml']],
    ['localized', LOCALIZED, ['/blog/2', '/blog/3', '/fr/blog/2', '/fr/blog/3', '/sitemap.xml']],
    ['slashed', SLASHED, ['/blog/', '/blog/2/', '/sitemap.xml']],
  ] as const) {
    const dir = await mkdtemp(join(base, `paginate-${name}-`))

    await Promise.all(Object.entries({ ...files, 'serve.ts': serve([...paths]) }).map(async ([path, content]) => Bun.write(join(dir, path), content)))
    projects.set(name, dir)
  }
})

afterAll(async () => {
  await Promise.all([...projects.values()].map(async dir => rm(dir, { recursive: true, force: true })))
})

async function run(command: string[], cwd: string): Promise<{ code: number, stdout: string, stderr: string }> {
  const child = Bun.spawn(command, { cwd, stdout: 'pipe', stderr: 'pipe' })
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])

  return { code, stdout, stderr }
}

async function served(name: string): Promise<Record<string, { status: number, body: string }>> {
  const { code, stdout, stderr } = await run([process.execPath, 'serve.ts'], projects.get(name)!)

  expect(stderr).not.toContain('error')
  expect(code).toBe(0)

  return JSON.parse(stdout) as Record<string, { status: number, body: string }>
}

const items = (body: string) => [...body.matchAll(/<li>(\w+)<\/li>/g)].map(match => match[1])

describe('a paginated list', () => {
  it('serves its first page at its own path and each other under its number, linking them under the site\'s base, and no other number', async () => {
    const answers = await served('paged')

    expect(items(answers['/blog']!.body)).toEqual(['a', 'b'])
    expect(answers['/blog']!.body).toContain('<p class="at">1/3</p><a class="next" href="/docs/blog/2">next</a>')
    expect(items(answers['/blog/2']!.body)).toEqual(['c', 'd'])
    expect(answers['/blog/2']!.body).toContain('<a class="prev" href="/docs/blog">prev</a><a class="next" href="/docs/blog/3">next</a>')
    expect(items(answers['/blog/3']!.body)).toEqual(['e'])
    expect(answers['/blog/3']!.body).not.toContain('class="next"')
    expect(answers['/blog/2']!.body).toContain('<link rel="canonical" href="https://example.com/docs/blog/2">')

    for (const path of ['/blog/4', '/blog/1', '/blog/0', '/blog/abc'])
      expect([path, answers[path]!.status]).toEqual([path, 404])

    expect([...answers['/sitemap.xml']!.body.matchAll(/<loc>([^<]+)<\/loc>/g)].map(match => match[1])).toEqual(['https://example.com/docs/blog', 'https://example.com/docs/blog/2', 'https://example.com/docs/blog/3'])
  })

  it('counts each locale\'s own entries, the default locale\'s standing in for those it lacks', async () => {
    const answers = await served('localized')

    expect(items(answers['/blog/2']!.body)).toEqual(['c', 'd'])
    expect(answers['/blog/2']!.body).not.toContain('class="next"')
    expect(answers['/blog/3']!.status).toBe(404)
    expect(answers['/fr/blog/2']!.body).toContain('<a class="prev" href="/fr/blog">prev</a><a class="next" href="/fr/blog/3">next</a>')
    expect(items(answers['/fr/blog/3']!.body)).toEqual(['e'])

    const locs = [...answers['/sitemap.xml']!.body.matchAll(/<loc>([^<]+)<\/loc>/g)].map(match => match[1])

    expect(locs).toContain('https://example.com/fr/blog/3')
    expect(locs).not.toContain('https://example.com/blog/3')
  })

  it('exported as prerender, has every page of each locale written by a static export, and no more', async () => {
    const root = projects.get('localized')!
    const build = await run([process.execPath, CLI, 'build', '--no-check', '--static', '--outdir', 'dist'], root)

    expect(build.stderr).not.toContain('error')
    expect(build.code).toBe(0)
    expect(items(await Bun.file(join(root, 'dist/blog.html')).text())).toEqual(['a', 'b'])
    expect(items(await Bun.file(join(root, 'dist/blog/2.html')).text())).toEqual(['c', 'd'])
    expect(items(await Bun.file(join(root, 'dist/fr/blog/3.html')).text())).toEqual(['e'])
    expect(await Bun.file(join(root, 'dist/blog/3.html')).exists()).toBe(false)
    expect(await Bun.file(join(root, 'dist/fr/blog/4.html')).exists()).toBe(false)
  }, 60_000)

  it('ends its links with a slash where the site\'s URLs do, and exported as sitemap alone lists its pages there', async () => {
    const answers = await served('slashed')

    expect(answers['/blog/']!.body).toContain('<a class="next" href="/blog/2/">next</a>')
    expect(answers['/blog/2/']!.body).toContain('<a class="prev" href="/blog/">prev</a>')
    expect([...answers['/sitemap.xml']!.body.matchAll(/<loc>([^<]+)<\/loc>/g)].map(match => match[1])).toEqual(['https://example.com/blog/', 'https://example.com/blog/2/'])
  })

  it('passes kay check, its page typed by its source', async () => {
    expect((await check(projects.get('paged')!, { site: 'https://example.com', base: '/docs' })).filter(diagnostic => diagnostic.severity !== 'warning')).toEqual([])
  })
})

describe('paginate, the size of a page', () => {
  it('names it pageSize, and keeps size as its old name', () => {
    const list = paginate([1, 2, 3], 2)

    expect(list.pageSize).toBe(2)
    expect(list.size).toBe(2)
  })
})
