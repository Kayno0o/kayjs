import { join } from 'node:path'
import { expect, test } from 'bun:test'
import { testSite } from 'kay/test'
import { cms } from '../../../src/extension'

const site = await testSite({ root: join(import.meta.dir, '..') })

// Counted once the response is sent: waits for every row asked for, as /Empty's target appears at its second visit.
async function recorded(want: number): Promise<string[]> {
  let paths: string[] = []

  for (let waited = 0; waited < 3000; waited += 50) {
    const page = await site.visit('/admin/not-found')

    paths = page.find('.kcms-missing-path').map(path => path.text)

    if (paths.length >= want && page.find('.kcms-missing tbody tr:first-child td:nth-child(3)').some(cell => cell.text.trim() === 'Visits2'))
      return paths

    await Bun.sleep(50)
  }

  return paths
}

test('the screen says so when nothing was recorded, and links stay under the prefix', async () => {
  const page = await site.visit('/admin/not-found')

  expect(page.find('.kui-empty-state-title').map(title => title.text)).toEqual(['No missing page recorded'])
  expect(page.text('.kui-empty-state-description')).toContain('production server records')
  expect(page.find('a').map(link => link.attributes.href).filter(href => href?.startsWith('//'))).toEqual([])
  expect(page.find('.kcms-admin-home')[0]?.attributes.href).toBe('/admin')
})

test('the empty state says kay dev counts nothing under kay dev, and what the production server records otherwise', async () => {
  const before = process.env.KAY_DEV_CODE

  try {
    process.env.KAY_DEV_CODE = '0'
    expect((await site.visit('/admin/not-found')).text('.kui-empty-state-description')).toContain('kay dev counts nothing: the production server records')

    delete process.env.KAY_DEV_CODE
    expect((await site.visit('/admin/not-found')).text('.kui-empty-state-description')).not.toContain('kay dev counts nothing')
  }
  finally {
    if (before === undefined)
      delete process.env.KAY_DEV_CODE
    else
      process.env.KAY_DEV_CODE = before
  }
})

test('a path with and without its trailing slash is one row with two visits and its target, one past 512 characters none, and a scanner\'s none', async () => {
  for (const path of ['/Empty/', '/Empty', `/${'a'.repeat(600)}`, '/wp-login.php'])
    expect((await site.fetch(path)).status).toBe(404)

  // Two paths are listed, the path and its target.
  expect(await recorded(2)).toEqual(['/Empty', '/empty'])

  const page = await site.visit('/admin/not-found')

  expect(page.find('.kcms-missing tbody tr:first-child td:nth-child(2)').map(cell => cell.text.trim())).toEqual(['Path/Empty'])
  expect(page.find('.kcms-missing tbody tr:first-child td:nth-child(3)').map(cell => cell.text.trim())).toEqual(['Visits2'])
})

test('adds the suggested redirect, which answers at once and is listed with its Remove, then undoes it; a hostile target is refused', async () => {
  const post = async (path: string, body: object, headers: Record<string, string> = {}) => site.fetch(`/api/cms/redirects${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) })

  expect((await post('', { from: '/Empty', to: '/empty' }, { 'x-deny': '1' })).status).toBe(403)

  for (const to of ['//evil.example', 'https://evil.example/', '/\\evil.example', '/nothing-serves-this'])
    expect((await post('', { from: '/Empty', to })).status).toBe(400)

  expect((await site.fetch('/Empty')).status).toBe(404)
  expect((await post('', { from: '/Empty', to: '/empty' })).status).toBe(200)

  const answered = await site.fetch('/Empty', { redirect: 'manual' })

  expect([answered.status, answered.headers.get('location')]).toEqual([307, '/empty'])

  const page = await site.visit('/admin/not-found')

  expect(page.find('.kcms-missing-path').map(path => path.text)).toContain('/empty')
  expect(page.text('main')).toContain('Redirects added here')

  expect((await post('/remove', { froms: ['/Empty'] })).status).toBe(200)
  expect((await site.fetch('/Empty')).status).toBe(404)
  expect((await post('', { from: '/Empty', to: '/empty', status: 308 })).status).toBe(200)
  expect((await site.fetch('/Empty', { redirect: 'manual' })).status).toBe(308)
  expect((await post('/remove', { froms: ['/Empty'] })).status).toBe(200)
})

test('offers a box for the target on a path with no suggestion', async () => {
  await site.fetch('/zzz-nothing-like-it')

  for (let waited = 0; waited < 3000; waited += 50) {
    const page = await site.visit('/admin/not-found')

    if (page.find('.kcms-missing-path').some(path => path.text === '/zzz-nothing-like-it')) {
      expect(page.find('.kcms-missing-add input').length).toBeGreaterThan(0)

      return
    }

    await Bun.sleep(50)
  }

  throw new Error('the path was never listed')
})

const post = async (path: string, body: object, headers: Record<string, string> = {}) => site.fetch(`/api/cms/redirects${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) })

// Waits for a path to be listed, counted once the response is sent.
async function listed(path: string, shown = true) {
  for (let waited = 0; waited < 3000; waited += 50) {
    const page = await site.visit('/admin/not-found')

    if (page.find('.kcms-missing-path').some(code => code.text === path) === shown)
      return page

    await Bun.sleep(50)
  }

  throw new Error(`${path} was ${shown ? 'never listed' : 'still listed'}`)
}

test('marks a path gone: it answers 410 with no location, and is listed with its code', async () => {
  expect((await post('', { from: '/retired-cms', to: '', status: 410 }, { 'x-deny': '1' })).status).toBe(403)
  expect((await post('', { from: '/retired-cms', to: '', status: 410 })).status).toBe(200)

  const answered = await site.fetch('/retired-cms', { redirect: 'manual' })

  expect([answered.status, answered.headers.get('location')]).toEqual([410, null])
  expect((await site.fetch('/retired-cms/?x=1', { redirect: 'manual' })).status).toBe(410)
  expect((await site.visit('/admin/not-found')).find('.kcms-redirects tbody tr').find(row => row.text.includes('/retired-cms'))?.text).toContain('410')

  // Edited in place into a redirect, then back to a 404.
  expect((await post('', { from: '/retired-cms', to: '/empty' })).status).toBe(200)
  expect((await site.fetch('/retired-cms', { redirect: 'manual' })).status).toBe(307)
  expect((await post('/remove', { froms: ['/retired-cms'] })).status).toBe(200)
  expect((await site.fetch('/retired-cms')).status).toBe(404)
  expect((await post('', { from: '/retired-cms', to: '/empty', status: 200 })).status).toBe(422)

  // The earlier shapes still work.
  expect((await post('', { from: '/retired-cms', to: '/empty', permanent: true })).status).toBe(200)
  expect((await site.fetch('/retired-cms', { redirect: 'manual' })).status).toBe(308)
  expect((await post('/remove', { from: '/retired-cms' })).status).toBe(200)
})

test('dismisses missing paths one by one or all at once, behind the guard', async () => {
  await site.fetch('/dismiss-one-cms')
  await site.fetch('/dismiss-two-cms')
  await listed('/dismiss-one-cms')
  await listed('/dismiss-two-cms')

  expect((await post('/dismiss', { paths: ['/dismiss-one-cms'] }, { 'x-deny': '1' })).status).toBe(403)
  expect(await (await post('/dismiss', { paths: ['/dismiss-one-cms', '/not-listed-cms'] })).json()).toEqual({ dismissed: 1 })
  await listed('/dismiss-one-cms', false)
  expect((await site.visit('/admin/not-found')).find('.kcms-missing-path').map(code => code.text)).toContain('/dismiss-two-cms')

  expect((await post('/clear', {}, { 'x-deny': '1' })).status).toBe(403)
  expect(((await (await post('/clear', {})).json()) as { cleared: number }).cleared).toBeGreaterThan(0)
  expect((await site.visit('/admin/not-found')).find('.kui-empty-state-title').map(title => title.text)).toEqual(['No missing page recorded'])
})

test('removes several added redirects at once', async () => {
  await post('', { from: '/bulk-cms-a', to: '/empty' })
  await post('', { from: '/bulk-cms-b', to: '', status: 410 })

  expect(await (await post('/remove', { froms: ['/bulk-cms-a', '/bulk-cms-b', '/bulk-cms-none'] })).json()).toEqual({ removed: 2 })
  expect((await site.fetch('/bulk-cms-b')).status).toBe(404)
})

test('names the page of the site that links to a missing path, with the time of the last visit', async () => {
  await site.fetch('/linked-from-cms', { headers: { referer: 'http://localhost/blog/hello?utm=private#top' } })
  await site.fetch('/linked-from-cms', { headers: { referer: 'https://search.example/results?q=private' } })

  const page = await listed('/linked-from-cms')
  const cells = page.find('.kcms-missing tbody tr').find(row => row.text.includes('/linked-from-cms'))?.text ?? ''

  expect(cells).toContain('/blog/hello')
  expect(cells).toContain('search.example')
  expect(cells).not.toContain('private')
  expect(cells).toMatch(/\d{4}-\d\d-\d\d \d\d:\d\d/)
  expect(page.find('thead th').map(th => th.text)).toContain('Last visit (UTC)')
})

test('offers the site\'s paths for the target, once for every row, and no hostile referrer page as a link', async () => {
  await site.fetch('/hostile-referrer-cms', { headers: { referer: 'http://localhost//evil.example/x' } })

  const page = await listed('/hostile-referrer-cms')

  expect(page.find('datalist option').map(option => option.attributes.value)).toEqual(expect.arrayContaining(['/about']))
  const boxes = page.find('.kcms-missing-add input[list]')

  expect(boxes.length).toBeGreaterThan(0)
  expect(boxes.every(input => input.attributes.list === 'kcms-site-paths')).toBe(true)
  expect(page.find('main a').map(link => link.attributes.href).filter(href => href?.includes('evil.example'))).toEqual([])
})

test('lists the redirects of kay.config.ts read-only, under a base and a trailing slash', async () => {
  const options = { guard: () => undefined }
  const based = await testSite({ root: join(import.meta.dir, '..'), base: '/cms', trailingSlash: 'always', redirects: { '/old-config': '/about', '/moved-config': { to: '/empty', status: 301 } }, extensions: [cms(options)] })

  cms(options)

  const page = await based.visit('/admin/not-found/')

  const rows = page.find('.kcms-config-redirects tbody tr').map(row => row.text)

  expect(rows).toHaveLength(2)
  expect(rows[0]).toMatch(/\/old-config.*\/about.*308/)
  expect(rows[1]).toMatch(/\/moved-config.*\/empty.*301/)
  expect(page.find('.kcms-config-redirects button')).toEqual([])
  expect(page.find('.kcms-admin-home')[0]?.attributes.href).toBe('/cms/admin')
})
