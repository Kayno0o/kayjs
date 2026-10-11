import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import process from 'node:process'
import { beforeAll, expect, test } from 'bun:test'
import { testSite } from 'kay/test'
import { BODY, parseMarker } from '../../../src/markers'
import { outage, products } from '../src/products'
import { saved } from '../src/saved'

const ROOT = join(import.meta.dir, '..')
// kay check prints this line on success since kay 1.18, nothing before.
const CLEAN = /^(?:checked with no problems in \d+ ms\n)?$/
const site = await testSite({ root: ROOT })
// One client throughout, so the edit-mode cookie it is given goes with its next visits.
let editor: Awaited<ReturnType<typeof testSite>>

beforeAll(async () => {
  editor = await testSite({ root: ROOT })
})

test('kay check passes on the fixture, the editor\'s components included', async () => {
  const check = Bun.spawn([process.execPath, join(ROOT, '..', '..', 'node_modules', '.bin', 'kay'), 'check'], { cwd: ROOT, stdout: 'pipe', stderr: 'pipe' })

  expect(await new Response(check.stdout).text() + await new Response(check.stderr).text()).toMatch(CLEAN)
  expect(await check.exited).toBe(0)
}, 60_000)

test('kay renders the editor in edit mode alone, a form per entry the page read, each loading in the browser', async () => {
  expect((await site.visit('/blog/hello')).find('aside.kcms-editor')).toEqual([])

  const page = await editor.visit('/admin/page?path=/blog/hello')

  expect(page.find('aside.kcms-editor-open')[0]?.attributes['aria-label']).toBe('Content editor')
  expect(page.find('.kcms-entry-title').map(title => title.text)).toEqual(['Posts'])
  expect(page.find('.kcms-entry-slug').map(slug => slug.text)).toEqual(['hello'])
  expect(page.find('.kcms-entry-loading')).toHaveLength(1)
})

test('the editor says when nothing on the page comes from a collection', async () => {
  const page = await editor.visit('/empty')

  expect(page.find('.kcms-editor-empty')[0]?.text).toBe('Nothing on this page comes from a collection.')
})

test('the screens list each collection with its entry count', async () => {
  const page = await site.visit('/admin')

  expect(page.find('.kui-card-row a').map(link => [link.text, link.attributes.href])).toEqual([['Posts', '/admin/collections/posts'], ['Products', '/admin/collections/products']])
  expect(page.text('main')).toContain('2 entries')
})

test('the screens and the editor render their own toaster, for an app rendering none', async () => {
  expect((await site.visit('/admin/collections/posts')).find('.kui-toaster')).toHaveLength(1)
  expect((await editor.visit('/admin/page?path=/blog/hello')).find('.kui-toaster')).toHaveLength(1)
})

test('a collection lists its entries, with a draft to publish, and searches them', async () => {
  const page = await site.visit('/admin/collections/posts')

  expect(page.find('.kcms-entries a').map(link => [link.text, link.attributes.href])).toEqual([
    ['Hello world', '/admin/collections/posts/hello'],
    ['Edit on page', '/admin/page?path=%2Fblog%2Fhello'],
    ['Spring garden', '/admin/collections/posts/notes/garden'],
    ['Edit on page', '/admin/page?path=%2Fblog%2Fnotes%252Fgarden'],
  ])
  expect(page.find('.kcms-entries button').map(button => button.text)).toContain('Publish')

  const searched = await site.visit('/admin/collections/posts?q=garden')

  expect(searched.find('.kcms-entries a').map(link => link.text)).toEqual(['Spring garden', 'Edit on page'])
})

test('an entry opens in a form of its collection\'s fields, nested slugs included', async () => {
  const page = await site.visit('/admin/collections/posts/notes/garden')

  expect(page.title()).toBe('notes/garden - Posts')
  expect(page.find('[data-kcms-path]').map(field => field.attributes['data-kcms-path'])).toEqual(['title', 'draft', 'tags'])
  expect(page.find('[data-kcms-body]')).toHaveLength(1)
})

test('a new entry asks for its slug, and no locale in a plain collection', async () => {
  expect((await site.visit('/admin/new/posts')).find('.kui-label-text').map(label => label.text)).toEqual(['Slug*', 'Title*', 'Tags', 'Body'])
})

test('an unknown collection or entry is a 404', async () => {
  expect((await site.fetch('/admin/collections/nope')).status).toBe(404)
  expect((await site.fetch('/admin/collections/posts/nope')).status).toBe(404)
  expect((await site.fetch('/admin/new/nope')).status).toBe(404)
})

test('opening a page through the screens puts it in edit mode, its fields marked as the editor reads them', async () => {
  const plain = await site.visit('/blog/hello')

  expect(plain.find('[data-kay-field]')).toEqual([])

  const page = await editor.visit('/admin/page?path=/blog/hello')
  const marked = page.find('[data-kay-field], [data-kay-list], [data-kay-body]').map(({ tag, attributes }) => {
    const [name, value] = Object.entries(attributes).find(([key]) => key.startsWith('data-kay-'))!

    return [tag, name, name === 'data-kay-list' ? value : parseMarker(value!, name === 'data-kay-body')]
  })

  expect(marked).toEqual([
    ['h1', 'data-kay-field', { collection: 'posts', slug: 'hello', path: 'title' }],
    ['ul', 'data-kay-list', 'posts:hello:tags'],
    ['li', 'data-kay-field', { collection: 'posts', slug: 'hello', path: 'tags.0' }],
    ['li', 'data-kay-field', { collection: 'posts', slug: 'hello', path: 'tags.1' }],
    ['article', 'data-kay-body', { collection: 'posts', slug: 'hello', path: BODY }],
  ])
  expect(page.html).toContain('<!--kay-field posts:hello:title-->Hello world<!--/kay-field-->')
})

async function send(method: string, path: string, body?: object): Promise<{ status: number, answer: unknown }> {
  const response = await site.fetch(`/api/cms/entries/${path}`, body === undefined ? { method } : { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

  return { status: response.status, answer: await response.json() }
}

test('saving a file entry hands the file kay wrote to the saver, as a commit', async () => {
  saved.length = 0

  expect(await send('POST', 'posts/hello', { data: { title: 'Hello again', tags: ['kay'] }, body: 'New body.\n' })).toEqual({ status: 200, answer: { saved: true, commit: { sha: 'c0ffee' } } })
  expect(saved.map(({ repoPath, message }) => [repoPath, message])).toEqual([['tests/fixture/src/content/posts/hello.md', 'content(posts): update hello']])
  expect(saved[0]?.text).toContain('title: Hello again')
  expect(saved[0]?.text).toContain('New body.')
})

test('a save kay\'s schema refuses comes back as issues, and nothing is written', async () => {
  saved.length = 0

  const { answer } = await send('POST', 'posts/hello', { data: { title: 3 } }) as { answer: { issues: { path: string }[] } }

  expect(answer.issues.map(issue => issue.path)).toContain('title')
  expect((await send('POST', 'posts/hello', { data: { title: 'Again' }, create: true })).answer).toEqual({ issues: [{ collection: 'posts', slug: 'hello', path: '', key: 'slug', message: 'names an entry the collection already holds' }] })
  expect(saved).toEqual([])
})

test('a nested slug is published and deleted through its file', async () => {
  saved.length = 0

  expect((await send('POST', 'posts/notes%2Fgarden/publish')).answer).toHaveProperty('saved', true)
  expect(saved[0]?.text).toContain('draft: false')
  expect((await send('DELETE', 'posts/notes%2Fgarden')).answer).toHaveProperty('saved', true)
  expect(saved.map(({ repoPath, text }) => [repoPath, text])[1]).toEqual(['tests/fixture/src/content/posts/notes/garden.md', undefined])
})

test('a loaded entry is created and removed through its loader', async () => {
  expect((await send('POST', 'products/lamp', { data: { name: 'Lamp' }, create: true })).answer).toEqual({ saved: true })
  expect(products.map(product => product.slug)).toEqual(['mug', 'lamp'])
  expect((await send('GET', 'products/lamp')).answer).toHaveProperty('entry.data.name', 'Lamp')
  expect((await send('DELETE', 'products/lamp')).answer).toEqual({ saved: true })
  expect(products.map(product => product.slug)).toEqual(['mug'])
})

test('kay\'s own rules refuse a folder slug naming another file, and removing a loaded entry it does not hold', async () => {
  saved.length = 0

  expect((await send('POST', 'posts/..%2Fescape', { data: { title: 'Out' }, create: true })).answer).toHaveProperty('issues.0.key', 'slug')
  expect((await send('DELETE', 'products/nope')).answer).toHaveProperty('issues.0.message', 'names no entry of the collection')
  expect(saved).toEqual([])
})

test('a loaded slug starting with / opens at its escaped path', async () => {
  expect((await send('POST', 'products/%2Fabout', { data: { name: 'About' }, create: true })).answer).toEqual({ saved: true })

  try {
    expect((await site.visit('/admin/collections/products')).find('.kcms-entries a').map(link => link.attributes.href)).toContain('/admin/collections/products/%2Fabout')
    expect((await site.visit('/admin/collections/products/%2Fabout')).title()).toBe('/about - Products')
  }
  finally {
    await send('DELETE', 'products/%2Fabout')
  }
})

test('a file that does not parse lists as broken, and is written over or deleted', async () => {
  const file = join(ROOT, 'src/content/posts/broken.json')

  await Bun.write(file, '{ "title": ')

  try {
    expect((await site.visit('/admin/collections/posts')).find('.kcms-entries .kui-badge').map(badge => badge.text)).toContain('Broken')

    const page = await site.visit('/admin/collections/posts/broken')

    expect(page.text('.kcms-failure')).toContain('does not parse')
    expect(page.find('[data-kcms-path]').map(field => field.attributes['data-kcms-path'])).toEqual(['title', 'draft', 'tags'])

    saved.length = 0

    expect((await send('POST', 'posts/broken', { data: { title: 'Mended' } })).answer).toHaveProperty('saved', true)
    expect((await send('DELETE', 'posts/broken')).answer).toHaveProperty('saved', true)
    expect(saved.map(({ repoPath, text }) => [repoPath, text === undefined ? undefined : JSON.parse(text)])).toEqual([['tests/fixture/src/content/posts/broken.json', { title: 'Mended' }], ['tests/fixture/src/content/posts/broken.json', undefined]])
  }
  finally {
    await rm(file, { force: true })
  }
})

test('a collection whose loader throws shows why on its screens, the others still listed', async () => {
  outage.message = 'the database is down'

  try {
    const index = await site.visit('/admin')

    expect(index.find('.kui-badge').map(badge => [badge.text, badge.attributes['data-tooltip']])).toEqual([['Cannot be read', expect.stringContaining('the database is down')]])
    expect(index.text('main')).toContain('2 entries')

    for (const path of ['/admin/collections/products', '/admin/collections/products/mug', '/admin/new/products'])
      expect((await site.visit(path)).text('main')).toContain('the database is down')
  }
  finally {
    outage.message = undefined
  }
})

test('a Markdown file whose frontmatter does not parse opens with its body kept', async () => {
  const file = join(ROOT, 'src/content/posts/torn.md')

  await Bun.write(file, '---\ntitle: [unclosed\n---\nThe body survives.\n')

  try {
    expect((await site.visit('/admin/collections/posts/torn')).text('[data-kcms-body] textarea')).toContain('The body survives.')
  }
  finally {
    await rm(file, { force: true })
  }
})

// A 1x1 PNG, which kay's storage reads the size of.
const PIXEL = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAwS2OUAAAAABJRU5ErkJggg=='), char => char.charCodeAt(0))

test('an upload is stored in its collection\'s folder, answered by the path that serves it', async () => {
  const form = new FormData()

  form.append('file', new File([PIXEL], 'pixel.png', { type: 'image/png' }))

  const response = await site.fetch('/api/cms/files/products', { method: 'POST', body: form })
  const { path } = await response.json() as { path: string }

  expect(path).toMatch(/^\/_kay\/files\/products\/\w+\.1x1\.png$/)
  expect(new Uint8Array(await (await site.fetch(path)).arrayBuffer())).toEqual(PIXEL)
  expect((await site.fetch('/api/cms/files/nope', { method: 'POST', body: form })).status).toBe(404)
})

test('an image field previews what it holds, takes a drop or a pick, and still a typed path', async () => {
  const page = await site.visit('/admin/collections/products/mug')

  expect(page.find('[data-kcms-path]').map(field => field.attributes['data-kcms-path'])).toEqual(['name', 'photo'])
  expect(page.find('[data-kcms-path="photo"] .kcms-file-drop')).toHaveLength(1)
  expect(page.find('[data-kcms-path="photo"] input[aria-label="Path"]')).toHaveLength(1)
})
