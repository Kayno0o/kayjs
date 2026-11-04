import type { Mounted } from 'kay/test'
import { afterEach, expect, test } from 'bun:test'
import { mountComponent } from 'kay/test'
import CollapsibleSection from '../src/collapsible-section.kay'
import PageHeader from '../src/page-header.kay'

let mounted: Mounted | undefined

afterEach(() => mounted?.unmount())

const LEVELS = [1, 2, 3, 4, 5, 6] as const

test('PageHeader draws its title as the heading of its level, an h1 by default', async () => {
  mounted = await mountComponent(PageHeader, { title: 'Moons' })
  expect(mounted.root.querySelector('h1')?.textContent).toBe('Moons')
  mounted.unmount()

  for (const level of LEVELS) {
    mounted = await mountComponent(PageHeader, { title: 'Moons', level })
    expect([...mounted.root.querySelectorAll('h1, h2, h3, h4, h5, h6')].map(heading => heading.tagName)).toEqual([`H${level}`])
    mounted.unmount()
  }

  mounted = await mountComponent(PageHeader, { title: 'Moons', level: 7 as never })
  expect(mounted.root.querySelector('h6')?.textContent).toBe('Moons')
})

test('CollapsibleSection draws its title as a heading in the summary at each level, a span without one', async () => {
  for (const level of LEVELS) {
    mounted = await mountComponent(CollapsibleSection, { title: 'Moons', level })
    expect([...mounted.root.querySelectorAll('summary > *')].map(node => node.tagName).filter(tag => tag.startsWith('H'))).toEqual([`H${level}`])
    mounted.unmount()
  }

  mounted = await mountComponent(CollapsibleSection, { title: 'Moons' })
  expect(mounted.root.querySelector('summary > span')?.textContent).toBe('Moons')
  expect(mounted.root.querySelector('h1, h2, h3, h4, h5, h6')).toBeNull()
})
