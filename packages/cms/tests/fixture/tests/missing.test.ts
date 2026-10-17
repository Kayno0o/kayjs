import { join } from 'node:path'
import { expect, test } from 'bun:test'
import { testSite } from 'kay/test'

const site = await testSite({ root: join(import.meta.dir, '..') })

// Counted once the response is sent: waits for every row asked for, as /Empty's target appears at its second visit.
async function recorded(want: number): Promise<string[]> {
  let paths: string[] = []

  for (let waited = 0; waited < 3000; waited += 50) {
    const page = await site.visit('/admin/not-found')

    paths = page.find('.kcms-missing-path').map(path => path.text)

    if (paths.length >= want && page.find('.kcms-missing tbody tr:first-child td:nth-child(2)').some(cell => cell.text.trim() === 'Visits2'))
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

  expect(page.find('.kcms-missing tbody tr:first-child td:nth-child(1)').map(cell => cell.text.trim())).toEqual(['Path/Empty'])
  expect(page.find('.kcms-missing tbody tr:first-child td:nth-child(2)').map(cell => cell.text.trim())).toEqual(['Visits2'])
})
