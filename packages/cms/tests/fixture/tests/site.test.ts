import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import process from 'node:process'
import { beforeAll, expect, setSystemTime, test } from 'bun:test'
import { testSite } from 'kay/test'
import { fileVersion } from '../../../src/files'
import { BODY, parseMarker } from '../../../src/markers'
import { outage, products, shop } from '../src/products'
import { saved } from '../src/saved'

const ROOT = join(import.meta.dir, '..')
// kay check prints this line on success since kay 1.18, nothing before.
const CLEAN = /^(?:checked with no problems in \d+ ms\n)?$/
const site = await testSite({ root: ROOT })
// One client throughout, so the edit-mode cookie it is given goes with its next visits.
let browserSite: ReturnType<typeof testSite> | undefined
let editor: Awaited<ReturnType<typeof testSite>>

// One build for every test that drives the browser.
const browser = async () => browserSite ??= testSite({ root: ROOT, browser: true })

beforeAll(async () => {
  editor = await testSite({ root: ROOT })
})

test('kay check passes on the fixture, the editor\'s components included', async () => {
  const check = Bun.spawn([process.execPath, join(ROOT, '..', '..', '..', '..', 'src', 'cli.ts'), 'check'], { cwd: ROOT, stdout: 'pipe', stderr: 'pipe' })

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

test('stopping editing leaves edit mode, the page rendering no editor again', async () => {
  const leaving = await testSite({ root: ROOT })

  expect((await leaving.visit('/admin/page?path=/blog/hello')).find('aside.kcms-editor')).toHaveLength(1)
  expect(await (await leaving.fetch('/api/cms/preview/exit', { method: 'POST' })).json()).toEqual({ left: true })
  expect((await leaving.visit('/blog/hello')).find('aside.kcms-editor')).toEqual([])
})

test('the editor says when nothing on the page comes from a collection', async () => {
  const page = await editor.visit('/empty')

  expect(page.find('.kcms-editor-empty')[0]?.text).toBe('Nothing on this page comes from a collection.')
})

test('the screens list each collection with its entry count', async () => {
  const page = await site.visit('/admin')

  expect(page.find('.kui-card-row a').map(link => [link.text, link.attributes.href])).toEqual([['Posts', '/admin/collections/posts'], ['Our products', '/admin/collections/products'], ['Shop', '/admin/collections/shop']])
  expect(page.text('main')).toContain('2 entries')
})

test('the screens and the editor render their own toaster, for an app rendering none', async () => {
  expect((await site.visit('/admin/collections/posts')).find('.kui-toaster')).toHaveLength(1)
  expect((await editor.visit('/admin/page?path=/blog/hello')).find('.kui-toaster')).toHaveLength(1)
})

test('the screens ship kayjs-ui\'s theme built by Tailwind', async () => {
  const built = await browser()
  const page = await built.visit('/admin')
  const links = page.find('link').filter(link => link.attributes.rel === 'stylesheet').map(link => link.attributes.href ?? '')
  // A page inlines its stylesheets when they compress small enough, and links them above.
  const css = [...page.find('style').map(style => style.html), ...await Promise.all(links.map(async href => (await built.fetch(href)).text()))].join('\n')

  expect(css).toContain('.kui-btn')
  expect(css).not.toContain('@apply')
}, 60_000)

test('typing in the editor shows the draft on the page and keeps the field focused', async () => {
  const built = await browser()
  const page = await built.open('/admin/page?path=/blog/hello')
  const title = '.kcms-editor input[type="text"]'

  await page.click(title)
  await page.press('End')
  await page.type(' again')
  await page.waitUntil(() => document.querySelector('h1')?.textContent?.endsWith(' again'))

  expect(await page.evaluate(selector => document.activeElement === document.querySelector(selector), title)).toBe(true)
  expect(page.errors).toEqual([])
}, 60_000)

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

  expect(page.title()).toBe('Spring garden - Posts')
  expect(page.find('[data-kcms-path]').map(field => field.attributes['data-kcms-path'])).toEqual(['title', 'draft', 'tags'])
  expect(page.find('[data-kcms-body]')).toHaveLength(1)
})

test('a new entry asks for its slug, and no locale in a plain collection', async () => {
  expect((await site.visit('/admin/new/posts')).find('.kui-label-text').map(label => label.text)).toEqual(['Slug*', 'Title*', 'Tags', 'Body'])
})

test('a collection\'s list shows the columns and the row actions its layout names', async () => {
  const page = await site.visit('/admin/collections/shop')

  expect(page.find('.kcms-entries th').map(head => head.text.trim())).toEqual(['Title', 'Price', 'Live', 'Actions'])
  expect(page.find('.kcms-entries td').map(cell => cell.text.trim())).toEqual(['TitleLamp', 'Price30', 'Live✓', 'Actions', 'TitleVase', 'Price12.5', 'Live', 'Actions'])
  expect(page.find('.kcms-entries a').map(link => link.text)).toEqual(['Lamp', 'Vase'])
  expect(page.find('.kcms-row-actions button').map(button => button.attributes['aria-label'] ?? button.text)).toEqual(['Delete Lamp', 'Delete Vase'])
  expect((await site.visit('/admin/collections/shop?q=vase')).find('.kcms-entries a').map(link => link.text)).toEqual(['Vase'])
})

test('a form is arranged by its layout: the named fields first, a row side by side, a hidden one left out', async () => {
  const page = await site.visit('/admin/new/shop')

  expect(page.find('.kcms-field[data-kcms-path]').map(field => field.attributes['data-kcms-path'])).toEqual(['price', 'stock', 'live', 'photo', 'name'])
  expect(page.find('.kcms-row').map(row => Array.from(row.html.matchAll(/data-kcms-path="(\w+)"/g), match => match[1]))).toEqual([['price'], ['stock', 'live'], ['photo'], ['name']])
  expect(page.find('.kui-label-text').map(label => label.text)[0]).toBe('Slug*')
  expect((await site.visit('/admin/collections/shop/lamp')).find('[data-kcms-path]')).not.toHaveLength(0)
})

test('an app\'s own screen built from the parts keeps the title, the actions, the fields it names and the notices', async () => {
  const page = await site.visit('/admin/collections/shop/lamp')

  expect(page.find('form.shop-entry')).toHaveLength(1)
  expect(page.find('h1.kcms-entry-name').map(heading => heading.text)).toEqual(['Lamp'])
  expect(page.find('[data-kcms-path]').map(field => field.attributes['data-kcms-path'])).toEqual(['photo', 'name', 'price', 'stock'])
  expect(page.find('.kcms-entry-actions button').map(button => button.text)).toContain('Save')
  expect((await site.fetch('/admin/collections/shop/nope')).status).toBe(404)
})

test('a field the layout hides still says why a save was refused', async () => {
  const built = await browser()
  const page = await built.open('/admin/new/shop')

  await page.waitUntil(() => document.querySelector('form.kcms-entry-editor input') !== null)
  await page.click('form.kcms-entry-editor input')
  await page.type('cup')
  await page.click('[data-kcms-path="name"] input')
  await page.type('Cup')
  await page.click('form.kcms-entry-editor button[type=submit]')
  await page.waitUntil(() => document.querySelector('.kcms-entry-failure[role=alert]') !== null)

  expect(shop.map(item => item.slug)).toEqual(['lamp', 'vase'])
  expect(await page.evaluate(() => [...document.querySelectorAll('.kcms-entry-failure[role=alert], p.kcms-entry-failure')].map(node => node.textContent))).toContain('Property \'sku\' is missing')
  expect(page.errors).toEqual([])
}, 60_000)

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

// The version of an entry's file as the editor opens it, which a save or a delete names.
async function versionOf(path: string): Promise<string> {
  return ((await send('GET', path)).answer as { entry: { version: string } }).entry.version
}

test('saving a file entry hands the file kay wrote to the saver, as a commit by the editor the app names', async () => {
  saved.length = 0

  const { answer: opened } = await send('GET', 'posts/hello') as { answer: { entry: { version: string } } }
  const file = Bun.file(`${import.meta.dir}/../src/content/posts/hello.md`)

  expect(opened.entry.version).toBe(fileVersion(await file.bytes()))
  expect(await send('POST', 'posts/hello', { data: { title: 'Hello again', tags: ['kay'] }, body: 'New body.\n', version: opened.entry.version })).toEqual({ status: 200, answer: { saved: true, commit: { sha: 'c0ffee' }, version: fileVersion(saved[0]!.text!) } })
  expect(saved[0]?.base).toBe(opened.entry.version)
  expect(saved.map(({ repoPath, message }) => [repoPath, message])).toEqual([['packages/cms/tests/fixture/src/content/posts/hello.md', 'content(posts): update hello']])
  expect(saved[0]?.text).toContain('title: Hello again')
  expect(saved[0]?.text).toContain('New body.')
  expect(saved[0]?.author).toEqual({ name: 'Fixture editor', email: 'editor@example.com' })
})

test('a save refused comes back as issues and nothing is written, a body showing code is kept', async () => {
  saved.length = 0

  const { answer } = await send('POST', 'posts/hello', { data: { title: 3 }, version: await versionOf('posts/hello') }) as { answer: { issues: { path: string }[] } }

  expect(answer.issues.map(issue => issue.path)).toContain('title')
  expect((await send('POST', 'posts/hello', { data: { title: 'Again' }, create: true })).answer).toEqual({ issues: [{ collection: 'posts', slug: 'hello', path: '', key: 'slug', message: 'names an entry the collection already holds' }] })
  expect((await send('POST', 'posts/..%2Fescape', { data: { title: 'Out' }, create: true })).answer).toHaveProperty('issues.0.key', 'slug')
  expect((await send('DELETE', 'products/nope')).answer).toHaveProperty('issues.0.message', 'names no entry of the collection')

  const { answer: unsafe } = await send('POST', 'posts/hello', { data: { title: 'Hello' }, body: 'Hi <script>alert(1)</script>\n', version: await versionOf('posts/hello') }) as { answer: { issues: { body?: true, message: string }[] } }

  expect(unsafe.issues).toEqual([expect.objectContaining({ body: true, message: expect.stringContaining('would run as the site') })])
  expect(saved).toEqual([])
  expect((await send('POST', 'posts/hello', { data: { title: 'Hello' }, body: '```html\n<script>shown, not run</script>\n```\n', version: await versionOf('posts/hello') })).answer).toHaveProperty('saved', true)
})

test('a nested slug is published and deleted through its file', async () => {
  saved.length = 0

  expect((await send('POST', 'posts/notes%2Fgarden/publish')).answer).toHaveProperty('saved', true)
  expect(saved[0]?.text).toContain('draft: false')
  expect((await send('DELETE', `posts/notes%2Fgarden?version=${await versionOf('posts/notes%2Fgarden')}`)).answer).toHaveProperty('saved', true)
  expect(saved.map(({ repoPath, text }) => [repoPath, text])[1]).toEqual(['packages/cms/tests/fixture/src/content/posts/notes/garden.md', undefined])
})

test('a loaded entry is created and removed through its loader, a slug starting with / opening at its escaped path', async () => {
  expect((await send('POST', 'products/lamp', { data: { name: 'Lamp' }, create: true })).answer).toEqual({ saved: true })
  expect(products.map(product => product.slug)).toEqual(['mug', 'lamp'])
  expect((await send('GET', 'products/lamp')).answer).toHaveProperty('entry.data.name', 'Lamp')
  expect((await send('DELETE', 'products/lamp')).answer).toEqual({ saved: true })
  expect(products.map(product => product.slug)).toEqual(['mug'])
  expect((await send('POST', 'products/%2Fabout', { data: { name: 'About' }, create: true })).answer).toEqual({ saved: true })

  try {
    expect((await site.visit('/admin/collections/products')).find('.kcms-entries a').map(link => link.attributes.href)).toContain('/admin/collections/products/%2Fabout')
    expect((await site.visit('/admin/collections/products/%2Fabout')).title()).toBe('About - Our products')
  }
  finally {
    await send('DELETE', 'products/%2Fabout')
  }
})

test('an entry\'s screen is headed by its title as the page\'s title, its slug beneath and the way back to its collection', async () => {
  const page = await site.visit('/admin/collections/posts/hello')

  expect(page.find('h1.kcms-entry-name').map(heading => heading.text)).toEqual(['Hello world'])
  expect(page.find('.kcms-entry-subtitle').map(line => line.text)).toEqual(['hello'])
  expect(page.find('.kcms-entry-crumb').map(link => [link.text, link.attributes.href])).toEqual([['Posts', '/admin/collections/posts']])
  expect(page.find('.kcms-entry-header button[type=submit]')).toHaveLength(1)
  expect((await site.visit('/admin/new/products')).find('h1.kcms-entry-name').map(heading => heading.text)).toEqual(['New entry'])
  expect((await site.visit('/admin/collections/products')).find('h1').map(heading => heading.text)).toEqual(['Our products'])
})

test('a file that does not parse lists as broken, why said on its link too, and is written over or deleted', async () => {
  const file = join(ROOT, 'src/content/posts/broken.json')

  await Bun.write(file, '{ "title": ')

  try {
    const listed = await site.visit('/admin/collections/posts')
    const link = listed.find('.kcms-entries a[aria-describedby]')

    expect(listed.find('.kcms-entries .kui-badge').map(badge => badge.text)).toContain('Broken')
    expect(link.map(found => found.text)).toEqual(['broken'])
    expect(listed.text(`#${link[0]!.attributes['aria-describedby']}`)).toBe(link[0]!.attributes['data-tooltip'])
    expect(listed.find('h1').map(heading => heading.text)).toEqual(['Posts'])

    const page = await site.visit('/admin/collections/posts/broken')

    expect(page.text('.kcms-failure')).toContain('does not parse')
    expect(page.find('[data-kcms-path]').map(field => field.attributes['data-kcms-path'])).toEqual(['title', 'draft', 'tags'])

    saved.length = 0

    expect((await send('POST', 'posts/broken', { data: { title: 'Mended' }, version: await versionOf('posts/broken') })).answer).toHaveProperty('saved', true)
    expect((await send('DELETE', `posts/broken?version=${await versionOf('posts/broken')}`)).answer).toHaveProperty('saved', true)
    expect(saved.map(({ repoPath, text }) => [repoPath, text === undefined ? undefined : JSON.parse(text)])).toEqual([['packages/cms/tests/fixture/src/content/posts/broken.json', { title: 'Mended' }], ['packages/cms/tests/fixture/src/content/posts/broken.json', undefined]])
  }
  finally {
    await rm(file, { force: true })
  }
})

test('a collection whose loader throws says so on its screens, its error kept to the log, the others still listed', async () => {
  outage.message = 'the database at db.internal:5432 is down'

  try {
    const index = await site.visit('/admin')

    expect(index.find('.kui-badge').map(badge => badge.text)).toEqual(['Cannot be read'])
    expect(index.find('main a[data-tooltip]').map(link => link.attributes['data-tooltip'])).toEqual([expect.stringContaining('failed to read')])
    expect(index.html).not.toContain('db.internal')
    expect(index.find('h1').map(heading => heading.text)).toEqual(['Content'])
    expect(index.text(`#${index.find('main a[aria-describedby]')[0]!.attributes['aria-describedby']}`)).toContain('failed to read')
    expect(index.text('main')).toContain('2 entries')

    for (const path of ['/admin/collections/products', '/admin/collections/products/mug', '/admin/new/products']) {
      const page = await site.visit(path)

      expect(page.text('main')).toContain('failed to read')
      expect(page.find('h1')).toHaveLength(1)
      expect(page.html).not.toContain('db.internal')
    }
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

test('an upload is stored in its collection\'s folder, answered by the path that serves it, a type not taken refused', async () => {
  const form = new FormData()

  form.append('file', new File([PIXEL], 'pixel.png', { type: 'image/png' }))

  const response = await site.fetch('/api/cms/files/products', { method: 'POST', body: form })
  const { path } = await response.json() as { path: string }

  expect(path).toMatch(/^\/_kay\/files\/products\/\w+\.1x1\.png$/)
  expect(new Uint8Array(await (await site.fetch(path)).arrayBuffer())).toEqual(PIXEL)
  expect((await site.fetch('/api/cms/files/nope', { method: 'POST', body: form })).status).toBe(404)

  const refused = new FormData()

  refused.append('file', new File(['alert(1)'], 'app.js', { type: 'image/png' }))

  const refusal = await site.fetch('/api/cms/files/products', { method: 'POST', body: refused })

  expect(refusal.status).toBe(415)
  expect(await refusal.text()).toContain('which uploads here do not take')
})

test('the editor is told the types and the size an upload may have', async () => {
  const rules = await (await site.fetch('/api/cms/files/rules')).json() as { accept: string, images: string, maxBytes: number }

  expect(rules.accept.split(',')).toContain('application/pdf')
  expect(rules.images.split(',')).not.toContain('application/pdf')
  expect(rules.images).not.toContain('svg')
  expect(rules.maxBytes).toBe(64 * 1024)
})

test('an upload exactly at uploads.maxSize is stored, one byte over refused by the server whatever the editor checks, an empty one too', async () => {
  const post = async (size: number) => {
    const form = new FormData()

    form.append('file', new File([new Uint8Array(size)], 'big.pdf', { type: 'application/pdf' }))

    return site.fetch('/api/cms/files/products', { method: 'POST', body: form })
  }

  expect((await post(64 * 1024)).status).toBe(200)

  const over = await post(64 * 1024 + 1)

  expect(over.status).toBe(413)
  expect(await over.text()).toBe('big.pdf is 64 KB, over the 64 KB an upload may be')
  // Past the route's body limit, refused before the body is read.
  expect((await post(1024 * 1024)).status).toBe(413)

  const empty = await post(0)

  expect(empty.status).toBe(400)
  expect(await empty.text()).toBe('big.pdf is empty')
})

test('the API refusals come back in the locale of the page that called, English from any other', async () => {
  const french = { referer: 'http://localhost/fr/products' }
  const english = { referer: 'http://localhost/products' }
  const refused = () => {
    const form = new FormData()

    form.append('file', new File(['alert(1)'], 'app.js', { type: 'image/png' }))

    return form
  }
  const upload = async (headers: Record<string, string>) => (await site.fetch('/api/cms/files/products', { method: 'POST', body: refused(), headers })).text()

  expect(await upload(french)).toContain('que les envois ici n\'acceptent pas')
  expect(await upload(english)).toContain('which uploads here do not take')
  expect(await (await site.fetch('/api/cms/entries/products/nope', { headers: french })).text()).toBe('Aucune entrée nope dans products')
  expect(await (await site.fetch('/api/cms/entries/products/nope', { headers: english })).text()).toBe('No entry nope in products')
  expect(await (await site.fetch('/api/cms/entries/nope/x', { headers: { 'accept-language': 'fr' } })).text()).toBe('Aucune collection nope')

  outage.message = 'down'

  try {
    const remove = async (headers: Record<string, string>) => (await site.fetch('/api/cms/files/unused/delete', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ keys: ['products/x.png'] }) })).text()

    expect(await remove(french)).toContain('Rien n\'a été supprimé')
    expect(await remove(english)).toContain('Nothing was deleted')
  }
  finally {
    outage.message = undefined
  }
})

test('the unused-uploads screen lists an upload no entry mentions, and deleting one removes it, a referenced one staying', async () => {
  const upload = async () => {
    const form = new FormData()

    form.append('file', new File([PIXEL], 'pixel.png', { type: 'image/png' }))

    return ((await (await site.fetch('/api/cms/files/products', { method: 'POST', body: form })).json()) as { path: string }).path
  }
  const [used, stray] = [await upload(), await upload()]
  const keyOf = (path: string) => path.slice('/_kay/files/'.length)
  const remove = async (keys: string[]) => site.fetch('/api/cms/files/unused/delete', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ keys }) })

  // The scan holds back what is under a day old.
  setSystemTime(new Date(Date.now() + 2 * 24 * 60 * 60 * 1000))
  products.push({ slug: 'cup', data: { name: 'Cup', photo: used } as { name: string } })

  try {
    const listed = async () => (await site.visit('/admin/uploads')).find('.kcms-uploads a').map(link => link.text)

    expect(await listed()).toContain(keyOf(stray))
    expect(await listed()).not.toContain(keyOf(used))
    expect((await site.visit('/admin/uploads')).text('main')).toContain('A URL written by hand in a page')
    expect(await (await remove([keyOf(used), keyOf(stray)])).json()).toEqual({ deleted: [keyOf(stray)], kept: [keyOf(used)] })
    expect(await listed()).not.toContain(keyOf(stray))
    expect((await site.fetch(stray)).status).toBe(404)
    expect((await site.fetch(used)).status).toBe(200)

    outage.message = 'down'
    expect((await remove([keyOf(used)])).status).toBe(409)
    expect((await site.visit('/admin/uploads')).text('main')).toContain('Uploads cannot be checked')
  }
  finally {
    setSystemTime()
    outage.message = undefined
    products.splice(products.findIndex(product => product.slug === 'cup'), 1)
  }
})

test('an image field previews what it holds, takes a drop or a pick, and still a typed path', async () => {
  const page = await site.visit('/admin/collections/products/mug')

  expect(page.find('[data-kcms-path]').map(field => field.attributes['data-kcms-path'])).toEqual(['name', 'photo', 'color', 'mood'])
  expect(page.find('[data-kcms-path="photo"] .kcms-file-drop')).toHaveLength(1)
  expect(page.find('[data-kcms-path="photo"] input[aria-label="Path"]')).toHaveLength(1)
})

test('a field kind the app adds is edited by its component, given the value and the label', async () => {
  const page = await site.visit('/admin/collections/products/mug')

  expect(page.find('[data-kcms-path="color"] input[type="color"]').map(input => input.attributes.value)).toEqual(['#ff0000'])
  expect(page.find('[data-kcms-path="color"]')[0]?.text).toContain('Color')
})

test('a kind with no component falls back to JSON and names the file to add', async () => {
  const before = process.env.NODE_ENV

  process.env.NODE_ENV = 'development'

  try {
    const page = await site.visit('/admin/collections/products/mug')

    expect(page.find('[data-kcms-path="mood"] textarea')).toHaveLength(1)
    expect(page.find('[data-kcms-path="mood"]')[0]?.text).toContain('No editor for the mood kind: add src/cms/fields/mood.kay')
  }
  finally {
    if (before === undefined)
      delete process.env.NODE_ENV
    else
      process.env.NODE_ENV = before
  }
})

test('the hint to add a component shows in development alone, not in production or with no NODE_ENV', async () => {
  const before = process.env.NODE_ENV
  const hinted = async (environment: string | undefined) => {
    if (environment === undefined)
      delete process.env.NODE_ENV
    else
      process.env.NODE_ENV = environment

    const page = await site.visit('/admin/collections/products/mug')

    expect(page.find('[data-kcms-path="mood"] textarea')).toHaveLength(1)

    return page.find('[data-kcms-path="mood"]')[0]?.text.includes('No editor for the mood kind') === true
  }

  try {
    expect(await hinted('development')).toBe(true)
    expect(await hinted('production')).toBe(false)
    expect(await hinted(undefined)).toBe(false)
  }
  finally {
    if (before === undefined)
      delete process.env.NODE_ENV
    else
      process.env.NODE_ENV = before
  }
})

test('a custom kind\'s value is validated by its schema alone on save', async () => {
  const refused = await send('POST', 'products/mug', { data: { name: 'Mug', color: 'red' } })

  expect((refused.answer as { issues: { path: string }[] }).issues.map(issue => issue.path)).toEqual(['color'])
  expect(products[0]?.data.color).toBe('#ff0000')
  expect((await send('POST', 'products/mug', { data: { name: 'Mug', color: '#00ff00', mood: 'calm' } })).answer).toEqual({ saved: true })
  expect(products[0]?.data.color).toBe('#00ff00')
  await send('POST', 'products/mug', { data: { name: 'Mug', color: '#ff0000', mood: 'calm' } })
})

test('picking a colour in the browser sets the draft and a save writes it', async () => {
  const built = await browser()
  const page = await built.open('/admin/collections/products/mug')

  await page.waitUntil(() => document.querySelector('[data-kcms-path="color"] input[type="color"]') !== null)
  await page.evaluate(() => {
    const input = document.querySelector<HTMLInputElement>('[data-kcms-path="color"] input[type="color"]')!

    input.value = '#0000ff'
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await page.click('.kcms-entry-actions button:last-child')

  for (let waited = 0; products[0]?.data.color !== '#0000ff' && waited < 5000; waited += 50)
    await Bun.sleep(50)

  try {
    expect(products[0]?.data.color).toBe('#0000ff')
    expect(page.errors).toEqual([])
  }
  finally {
    products[0]!.data.color = '#ff0000'
  }
}, 60_000)

// A paste as the browser sends it, its files in `clipboardData`.
async function paste(page: Awaited<ReturnType<typeof site.open>>, selector: string, name: string, type: string, bytes: Uint8Array): Promise<void> {
  await page.evaluate((target, fileName, fileType, content) => {
    const data = new DataTransfer()

    data.items.add(new File([new Uint8Array(content)], fileName, { type: fileType }))
    document.querySelector(target)!.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }))
  }, selector, name, type, [...bytes])
}

test('an image pasted into the Markdown body is uploaded to the collection\'s folder and embedded where the cursor is, and the save keeps it', async () => {
  saved.length = 0

  const built = await browser()
  const page = await built.open('/admin/collections/posts/hello')
  const body = '[data-kcms-body] textarea'

  await page.click(body)
  await paste(page, body, 'moon.png', 'image/png', PIXEL)
  await page.waitUntil(() => document.querySelector<HTMLTextAreaElement>('[data-kcms-body] textarea')!.value.includes('![](/_kay/files/posts/'))

  const text = (await page.value(body))!
  const path = (/!\[\]\((\/_kay\/files\/posts\/\w+\.1x1\.png)\)/).exec(text)![1]!

  expect(text).not.toContain('Uploading')
  expect(new Uint8Array(await (await built.fetch(path)).arrayBuffer())).toEqual(PIXEL)

  await page.click('.kcms-entry-actions button:last-child')

  for (let waited = 0; saved.length === 0 && waited < 5000; waited += 50)
    await Bun.sleep(50)

  expect(saved[0]?.text).toContain(`![](${path})`)
  expect(page.errors).toEqual([])
}, 60_000)

test('a refused upload toasts, and leaves the body as it was', async () => {
  const built = await browser()
  const page = await built.open('/admin/collections/posts/hello')
  const body = '[data-kcms-body] textarea'
  const before = await page.value(body)

  await page.click(body)
  await paste(page, body, 'logo.svg', 'image/svg+xml', new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>'))
  await page.waitUntil(() => document.querySelector('.kui-toaster')?.textContent?.includes('which uploads here do not take') === true)

  expect(await page.value(body)).toBe(before)
  expect(page.errors).toEqual([])
}, 60_000)

test('a file field offers only the types the server takes, and says why a dropped file is left out', async () => {
  const built = await browser()
  const page = await built.open('/admin/collections/products/mug')

  await page.waitUntil(() => document.querySelector('.kcms-file input[type=file]')?.getAttribute('accept') === 'image/png,image/jpeg,image/webp,image/gif,image/avif')
  await page.evaluate(() => {
    const data = new DataTransfer()

    data.items.add(new File(['<svg xmlns="http://www.w3.org/2000/svg"/>'], 'logo.svg', { type: 'image/svg+xml' }))
    document.querySelector('.kcms-file-drop')!.dispatchEvent(new DragEvent('drop', { dataTransfer: data, bubbles: true, cancelable: true }))
  })
  await page.waitUntil(() => document.querySelector('.kui-toaster')?.textContent?.includes('logo.svg is image/svg+xml that uploads here do not take') === true)

  expect(page.errors).toEqual([])
}, 60_000)

test('a file over the size limit is refused before it is sent, with its size in the toast', async () => {
  const built = await browser()
  const page = await built.open('/admin/collections/products/mug')

  await page.waitUntil(() => document.querySelector('.kcms-file input[type=file]')?.getAttribute('accept') !== null)
  await page.evaluate(() => {
    const data = new DataTransfer()

    data.items.add(new File([new Uint8Array(100 * 1024)], 'huge.png', { type: 'image/png' }))
    document.querySelector('.kcms-file-drop')!.dispatchEvent(new DragEvent('drop', { dataTransfer: data, bubbles: true, cancelable: true }))
  })
  await page.waitUntil(() => document.querySelector('.kui-toaster')?.textContent?.includes('huge.png is 100 KB, over the 64 KB an upload may be') === true)

  expect(page.errors).toEqual([])
}, 60_000)

const PHONE = { width: 375, height: 700 }
// WCAG 2.5.8's minimum target size.
const TAP = 24
const SCREENS = ['/admin', '/admin/collections/posts', '/admin/collections/posts?q=garden', '/admin/collections/posts?q=zzz', '/admin/collections/posts/hello', '/admin/collections/posts/notes/garden', '/admin/new/posts', '/admin/collections/products/mug', '/admin/collections/shop', '/admin/new/shop', '/admin/collections/shop/lamp', '/admin/uploads']

// What a 375 px screen gets wrong: it scrolls sideways, a control spills past the screen or its own scrolling table, or one is too short to tap.
async function phoneProblems(path: string): Promise<string[]> {
  const built = await browser()
  const page = await built.open(path, PHONE)

  try {
    await page.waitUntil(() => document.querySelector('h1') !== null)

    return await page.evaluate((tap) => {
      const found: string[] = []
      const width = document.documentElement.clientWidth

      // The stacked cards need the viewport to be the phone's.
      if (innerWidth !== 375)
        found.push(`the viewport is ${innerWidth} px wide, not 375`)

      if (document.documentElement.scrollWidth > width)
        found.push(`page scrolls sideways: ${document.documentElement.scrollWidth} > ${width}`)

      for (const control of document.querySelectorAll<HTMLElement>('main a[href], main button, main input, main select, main textarea')) {
        const box = control.getBoundingClientRect()

        if (box.width === 0 || box.height === 0 || getComputedStyle(control).visibility === 'hidden')
          continue

        const name = `${control.tagName.toLowerCase()} "${(control.textContent || control.getAttribute('aria-label') || control.getAttribute('name') || '').trim().slice(0, 30)}"`
        // A control inside a table that scrolls on its own is reached by scrolling it.
        const scroller = control.closest('.kui-table-wrap')
        const limit = scroller === null ? width : scroller.getBoundingClientRect().right

        // A checkbox is tapped through its label.
        const target = control.matches('input[type="checkbox"]') ? control.closest('label')?.getBoundingClientRect() ?? box : box

        if (control.matches('button, input, select, textarea, a.kui-btn') && (target.height < tap || target.width < tap))
          found.push(`${name} is ${Math.round(target.width)}x${Math.round(target.height)} px`)

        if (box.left < -1 || box.right > limit + 1)
          found.push(`${name} spans ${Math.round(box.left)}-${Math.round(box.right)} of ${Math.round(limit)}`)
      }

      return found
    }, TAP)
  }
  finally {
    page.close()
  }
}

test.each(SCREENS)('%s fits a 375 px phone: no sideways page scroll, every control inside the screen and big enough to tap', async (path) => {
  expect(await phoneProblems(path)).toEqual([])
}, 60_000)

test('the unused-uploads screen fits a 375 px phone with an upload to delete', async () => {
  const form = new FormData()

  form.append('file', new File([PIXEL], 'phone.png', { type: 'image/png' }))

  const built = await browser()
  const key = ((await (await built.fetch('/api/cms/files/products', { method: 'POST', body: form })).json()) as { path: string }).path.slice('/_kay/files/'.length)

  setSystemTime(new Date(Date.now() + 2 * 24 * 60 * 60 * 1000))

  try {
    expect((await built.visit('/admin/uploads')).find('.kcms-uploads a').map(link => link.text)).toContain(key)
    expect(await phoneProblems('/admin/uploads')).toEqual([])
  }
  finally {
    await built.fetch('/api/cms/files/unused/delete', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ keys: [key] }) })
    setSystemTime()
  }
}, 60_000)
