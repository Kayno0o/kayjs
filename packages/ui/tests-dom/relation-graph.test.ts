import type { Mounted } from 'kay/test'
import { afterEach, expect, test } from 'bun:test'
import { mountComponent, settle } from 'kay/test'
import RelationGraphs from '../tests/fixture/src/components/relation-graphs.kay'
import { click } from './dom'

let mounted: Mounted | undefined

afterEach(() => mounted?.unmount())

async function graphs(props: Record<string, unknown> = {}) {
  mounted = await mountComponent(RelationGraphs, { onSelect: () => undefined, ...props })

  return mounted.root
}

const nodes = (root: Element, id: string) => [...root.querySelectorAll(`#${id} [data-part="node"]`)]

test('the neighbours read in the order of the list, as a link, a button for the rest and a muted gap', async () => {
  const root = await graphs()

  expect(nodes(root, 'bound').map(node => [node.tagName, node.textContent, node.getAttribute('href')])).toEqual([['A', 'Phobos', '/phobos'], ['SPAN', 'Deimos', null], ['BUTTON', 'Io', null]])
  expect(root.querySelector('#bound [data-part="centre"]')?.textContent).toBe('Mars')
  expect([...root.querySelectorAll('#bound [data-part="line"]')].map(line => line.hasAttribute('data-missing'))).toEqual([false, true, false])
})

test('pressing a button tells onSelect and the app marks the neighbour it holds', async () => {
  const picks: (string | number)[] = []
  const root = await graphs({ onSelect: (key: string | number) => picks.push(key) })

  click(root.querySelector('#bound button'))
  await settle()

  expect(picks).toEqual(['io'])
  expect(nodes(root, 'bound').map(node => node.getAttribute('aria-current'))).toEqual([null, null, 'true'])
})

test('a function source is asked in the browser and its answer drawn', async () => {
  const root = await graphs({ items: async () => [{ key: 'a', label: 'Venus A' }, { key: 'b', label: 'Venus B' }] })

  await settle()
  await settle()

  expect(nodes(root, 'late').map(node => node.textContent)).toEqual(['Venus A', 'Venus B'])
  expect(root.querySelector('#late')?.hasAttribute('aria-busy')).toBe(false)
})

test('a rejected source reads the failure and offers to ask again', async () => {
  const root = await graphs({ items: async () => {
    throw new Error('down')
  } })

  await settle()
  await settle()

  expect(root.querySelector('#late [data-part="status"]')?.textContent).toBe('Could not load the neighbours')
  expect(root.querySelector('#late [data-part="retry"]')?.textContent).toBe('Try again')
})

test('@neighbour and @middle replace the text', async () => {
  const root = await graphs()

  expect(nodes(root, 'blocks').map(node => node.textContent)).toEqual(['1. Phobos', '2. Deimos', '3. Io'])
  expect(root.querySelector('#blocks [data-part="centre"]')?.textContent).toBe('<Earth>')
})
