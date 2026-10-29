import type { Mounted } from 'kay/test'
import { afterEach, describe, expect, test } from 'bun:test'
import { mountComponent, settle } from 'kay/test'
import PlanetTabs from '../tests/fixture/src/components/planet-tabs.kay'
import QueryTabs from '../tests/fixture/src/components/query-tabs.kay'
import { click } from './dom'

let mounted: Mounted | undefined

afterEach(() => {
  mounted?.unmount()
})

function reads(root: Element) {
  return {
    stops: [...root.querySelectorAll('[role="tab"]')].filter(tab => tab.getAttribute('tabindex') === '0').map(tab => tab.textContent),
    panels: [...root.querySelectorAll<HTMLElement>('[role="tabpanel"]')].filter(panel => panel.hidden === false).map(panel => panel.querySelector('input')?.name ?? panel.textContent),
  }
}

describe('a value naming no enabled tab', () => {
  test('shows the first tab, as the only stop of the tab order, and tells onChange nothing', async () => {
    const changes: string[] = []

    mounted = await mountComponent(PlanetTabs, { value: 'missing', onChange: (value: string) => changes.push(value) })
    expect(reads(mounted.root)).toEqual({ stops: ['Mars'], panels: ['mars'] })
    expect(changes).toEqual([])
  })

  test('shows the first enabled tab for a value that is disabled', async () => {
    mounted = await mountComponent(PlanetTabs, { value: 'venus', disabledFirst: true })
    expect(reads(mounted.root).stops).toEqual(['Earth'])
  })
})

describe('tabs of a query param', () => {
  async function open(search: string, props: { paramDefault?: string, onChange?: (value: string) => void } = {}) {
    ;(window as unknown as { happyDOM: { setURL: (url: string) => void } }).happyDOM.setURL(`http://localhost/product${search}`)

    return mountComponent(QueryTabs, props)
  }

  test('show the tab the address names from the first paint', async () => {
    mounted = await open('?tab=reviews&sort=new')
    expect(reads(mounted.root)).toEqual({ stops: ['Reviews'], panels: ['reviews'] })
  })

  test('show the first tab while the param is left out or names no tab', async () => {
    for (const search of ['', '?tab=nothing']) {
      mounted?.unmount()
      mounted = await open(search)
      expect(reads(mounted.root).stops).toEqual(['Details'])
    }
  })

  test('write a pick into the address, the other params kept and no entry added, and leave the default out', async () => {
    const changes: string[] = []
    const entries = history.length

    mounted = await open('?sort=new', { paramDefault: 'details', onChange: value => changes.push(value) })
    click(mounted.root.querySelectorAll('[role="tab"]')[2]!)
    await settle()
    await new Promise(resolve => setTimeout(resolve, 250))
    expect(location.search).toBe('?sort=new&tab=shipping')
    expect(reads(mounted.root).panels).toEqual(['shipping'])

    click(mounted.root.querySelectorAll('[role="tab"]')[0]!)
    await settle()
    await new Promise(resolve => setTimeout(resolve, 250))
    expect(location.search).toBe('?sort=new')
    expect(changes).toEqual(['shipping', 'details'])
    expect(history.length).toBe(entries)
  })
})
