import { expect, it } from 'bun:test'
import { testSite } from 'kay/test'
import { ui } from '../src/extension'

const SLOT = /<slot data-component="[^"]*(?:app-header|site-nav)[^"]*"/g

it('draws an AppHeader and a SiteNav as markup until the page sets the menu', async () => {
  const site = await testSite({ root: `${import.meta.dir}/fixture`, extensions: [ui()] })

  try {
    const plain = (await site.visit('/header-static')).html
    const open = (await site.visit('/header-open')).html

    expect(plain).toContain('data-part="toggle"')
    expect(plain.match(SLOT)).toBeNull()
    expect(open.match(SLOT)?.length).toBeGreaterThan(0)
  }
  finally {
    await site.close()
  }
}, 60_000)
