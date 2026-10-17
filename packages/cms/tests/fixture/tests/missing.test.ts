import { join } from 'node:path'
import { expect, test } from 'bun:test'
import { testSite } from 'kay/test'

const site = await testSite({ root: join(import.meta.dir, '..') })

// Counted once the response is sent.
async function recorded(): Promise<string[]> {
  for (let waited = 0; waited < 3000; waited += 50) {
    const paths = (await site.visit('/admin/not-found')).find('.kcms-missing-path').map(path => path.text)

    if (paths.length > 0)
      return paths

    await Bun.sleep(50)
  }

  return []
}

test('the screen says so when nothing was recorded, and links stay under the prefix', async () => {
  const page = await site.visit('/admin/not-found')

  expect(page.find('.kui-empty-state-title').map(title => title.text)).toEqual(['No missing page recorded'])
  expect(page.text('.kui-empty-state-description')).toContain('production server records')
  expect(page.find('a').map(link => link.attributes.href).filter(href => href?.startsWith('//'))).toEqual([])
  expect(page.find('.kcms-admin-home')[0]?.attributes.href).toBe('/admin')
})

test('a path with and without its trailing slash is one row, one past 512 characters none, and a scanner\'s none', async () => {
  for (const path of ['/Empty/', '/Empty', `/${'a'.repeat(600)}`, '/wp-login.php'])
    expect((await site.fetch(path)).status).toBe(404)

  expect(await recorded()).toEqual(['/Empty', '/empty'])

  const row = (await site.visit('/admin/not-found')).find('.kcms-missing tbody tr')[0]!.text.replaceAll(/\s+/g, ' ')

  expect(row).toContain('2')
})
