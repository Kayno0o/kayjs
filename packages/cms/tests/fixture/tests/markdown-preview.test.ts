import { rm, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, expect, test } from 'bun:test'
import { testSite } from 'kay/test'

const site = await testSite({ root: join(import.meta.dir, '..') })

async function render(markdown: string, headers: Record<string, string> = {}, place: Record<string, string> = {}): Promise<Response> {
  return site.fetch('/api/cms/markdown', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ markdown, ...place }) })
}

const image = async (path: string, collection = 'posts', slug = 'hello') => site.fetch(`/api/cms/markdown/image?${new URLSearchParams({ collection, slug, path })}`)
const link = join(import.meta.dir, '../src/content/posts/escape.png')

afterAll(async () => {
  await rm(link, { force: true })
})

test('renders a text as the site\'s pipeline does, with its images and tables kept', async () => {
  const response = await render('# Title\n\nSome **bold** and ![cat](/uploads/cat.png)\n\n| a | b |\n| - | - |\n| 1 | 2 |\n')
  const { html } = await response.json() as { html: string }

  expect(response.status).toBe(200)
  expect(html).toContain('<strong>bold</strong>')
  expect(html).toContain('<h1')
  expect(html).toContain('src="/uploads/cat.png"')
  expect(html).toContain('<td>1</td>')
})

test('shows a component as its content, a heading without its anchor, and a link in a new tab', async () => {
  const { html } = await (await render('# Title\n\n<Card title="x">hello **w**</Card>\n\n<Badge text="n" />\n\n[out](https://example.com)')).json() as { html: string }

  expect(html).not.toContain('kay-component')
  expect(html).not.toContain('&lt;')
  expect(html).toContain('hello <strong>w</strong>')
  expect(html).toMatch(/<h1[^>]*>Title<\/h1>/)
  expect(html).toContain('<a target="_blank" href="https://example.com"')
})

test('drops what would run in the screens, whatever the collection allows in its pages', async () => {
  const { html } = await (await render('Hi <script>alert(1)</script><img src="/a.png" onerror="alert(2)"> [x](javascript:alert(3))')).json() as { html: string }

  expect(html).not.toContain('<script')
  expect(html).not.toContain('onerror')
  expect(html).not.toContain('javascript:')
})

test('answers 422 with the reason for a component kay cannot read, and refuses what the guard refuses', async () => {
  const bad = await render('text\n\n</Card>')

  expect(bad.status).toBe(422)
  expect(await bad.text()).toContain('</Card> closes no component')
  expect((await render('x', { 'x-deny': '1' })).status).toBe(403)
  expect((await site.fetch('/api/cms/markdown', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status).toBe(422)
})

test('highlights a fenced block with the site\'s highlighter, keeping its colours and nothing that runs or loads', async () => {
  const { html } = await (await render('```ts\nconst a = 1 < 2\n```\n\n<pre><code class="language-ts" onclick="alert(3)">x</code></pre>')).json() as { html: string }

  expect(html).toContain('<pre class="shiki" style="color:#123456"')
  expect(html).toContain('const a = 1 &lt; 2')
  expect(html).not.toContain('onclick')
  expect(html).not.toContain('javascript:')
  expect(html).toContain('style="color:#ff0000"')
  expect(html).not.toMatch(/<pre>[0-9a-f-]{36}\d/)
})

test('shows an image written as a path in the entry\'s folder from there, and leaves other sources alone', async () => {
  const { html } = await (await render('![a](./pic.png) ![b](/uploads/b.png) ![c](https://example.com/c.png) ![d](//example.com/d.png)', {}, { collection: 'posts', slug: 'hello' })).json() as { html: string }

  expect(html).toContain('src="/api/cms/markdown/image?collection=posts&amp;slug=hello&amp;path=.%2Fpic.png"')
  expect(html).toContain('src="/uploads/b.png"')
  expect(html).toContain('src="https://example.com/c.png"')
  expect(html).not.toContain('d.png')

  const shown = await image('./pic.png')

  expect(shown.status).toBe(200)
  expect(shown.headers.get('content-type')).toBe('image/png')
  expect((await shown.bytes()).length).toBeGreaterThan(8)
  expect((await image('../pic.png', 'posts', 'notes/garden')).status).toBe(200)
})

test('shows no relative image without the entry it is written for', async () => {
  const { html } = await (await render('![a](./pic.png)')).json() as { html: string }

  expect(html).not.toContain('src=')
})

test('reads no file outside the collection\'s folder, no other type than an image, and none through a link', async () => {
  expect((await image('../../outside.png')).status).toBe(404)
  expect((await image('../../../kay.config.ts')).status).toBe(404)
  expect((await image('hello.md')).status).toBe(404)
  expect((await image('pic.svg')).status).toBe(404)
  expect((await image('./pic.png', 'nope')).status).toBe(404)
  expect((await image('../../outside.png', 'posts', '../../x')).status).toBe(404)
  expect((await image('%2e%2e/%2e%2e/outside.png')).status).toBe(404)

  await symlink(join(import.meta.dir, '../src/outside.png'), link)

  expect((await image('escape.png')).status).toBe(404)
})

test('lets the browser keep a preview image but ask again, an unchanged file answering 304', async () => {
  const first = await image('./pic.png')
  const etag = first.headers.get('etag')!

  expect(first.headers.get('cache-control')).toBe('private, no-cache')
  expect(etag).toStartWith('W/"')

  const again = await site.fetch(`/api/cms/markdown/image?${new URLSearchParams({ collection: 'posts', slug: 'hello', path: './pic.png' })}`, { headers: { 'if-none-match': etag } })

  expect(again.status).toBe(304)
  expect(await again.text()).toBe('')
})
