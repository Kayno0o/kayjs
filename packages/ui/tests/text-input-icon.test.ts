import { expect, it } from 'bun:test'
import { testSite } from 'kay/test'
import { ui } from '../src/extension'

it('draws a leading icon inside a text box, hidden from screen readers, and the search icon for a search box', async () => {
  const site = await testSite({ root: `${import.meta.dir}/fixture`, extensions: [ui()], islands: false })

  try {
    const html = (await site.visit('/text-icon')).html
    const box = (id: string) => html.match(new RegExp(`<input[^>]*id="${id}"[^>]*>`))![0]
    const field = (id: string) => html.slice(html.lastIndexOf('<span', html.indexOf(`id="${id}"`)), html.indexOf(`id="${id}"`))

    expect(field('plain')).not.toContain('<svg')
    expect(box('plain')).not.toContain(' data-icon ')

    expect(field('search')).toContain('<svg')
    expect(field('search')).toContain('aria-hidden="true"')
    expect(box('search')).toContain(' data-icon ')

    expect(box('bare')).not.toContain(' data-icon ')
    expect(html).toContain(`<!--[-->${box('bare')}`)

    expect(field('own')).toContain('<svg')
    expect(box('sized')).toContain('data-size="sm"')
    expect(box('sized')).toContain('w-full')
    expect(field('sized')).toContain('text-accent')

    // A combobox takes the icon the same way.
    const combo = (label: string) => html.slice(html.indexOf(`aria-label="${label}"`) - 700, html.indexOf(`aria-label="${label}"`))

    expect(combo('Pick')).toContain('data-part="icon"')
    expect(combo('Nopick')).not.toContain('data-part="icon"')
  }
  finally {
    await site.close()
  }
}, 60_000)
