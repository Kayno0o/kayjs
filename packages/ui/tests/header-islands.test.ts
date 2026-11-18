import { expect, it } from 'bun:test'
import { testSite } from 'kay/test'
import { ui } from '../src/extension'

const SLOT = /<slot data-component="[^"]*(?:app-header|site-nav)[^"]*"/g

it('draws an AppHeader and a SiteNav as markup until the page sets the menu', async () => {
  const site = await testSite({ root: `${import.meta.dir}/fixture`, config: { extensions: [ui()] } })

  try {
    const plain = (await site.visit('/header-static')).html
    const open = (await site.visit('/header-open')).html
    const linked = (await site.visit('/header-nav-open')).html

    expect(plain).toContain('data-part="toggle"')
    expect(plain.match(SLOT)).toBeNull()
    expect(open.match(SLOT)?.length).toBeGreaterThan(0)
    expect(linked.match(SLOT)).toHaveLength(1)
  }
  finally {
    await site.close()
  }
}, 60_000)

it('draws a Table with a @cell block from a page as markup, the block rendered by the server', async () => {
  const site = await testSite({ root: `${import.meta.dir}/fixture`, config: { extensions: [ui()] } })

  try {
    const { html } = await site.visit('/linked-cells')

    expect(html).toContain('href="#audit-1"')
    expect(html).toContain('href="#audit-2"')
    expect(html).not.toContain('src/table.kay')
  }
  finally {
    await site.close()
  }
}, 60_000)
