import { join } from 'node:path'
import { expect, test } from 'bun:test'
import { testSite } from 'kay/test'

const site = await testSite({ root: join(import.meta.dir, '..') })

async function render(markdown: string, headers: Record<string, string> = {}): Promise<Response> {
  return site.fetch('/api/cms/markdown', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ markdown }) })
}

test('renders a text as the site\'s pipeline does, with its images and tables kept', async () => {
  const response = await render('# Title\n\nSome **bold** and ![cat](/uploads/cat.png)\n\n| a | b |\n| - | - |\n| 1 | 2 |\n')
  const { html } = await response.json() as { html: string }

  expect(response.status).toBe(200)
  expect(html).toContain('<strong>bold</strong>')
  expect(html).toContain('<h1')
  expect(html).toContain('src="/uploads/cat.png"')
  expect(html).toContain('<td>1</td>')
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
  expect((await site.fetch('/api/cms/markdown', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status).toBeGreaterThanOrEqual(400)
})
