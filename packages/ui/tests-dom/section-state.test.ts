import type { Mounted } from 'kay/test'
import { afterEach, expect, test } from 'bun:test'
import { mountComponent, settle } from 'kay/test'
import SectionState from '../tests/fixture/src/components/section-state.kay'
import { click } from './dom'

let mounted: Mounted | undefined

afterEach(() => mounted?.unmount())

async function mount(props: { multiple?: boolean, controlled?: boolean } = {}) {
  const calls: string[] = []

  mounted = await mountComponent(SectionState, { calls, ...props })
  await settle()

  return { root: mounted.root, calls, sections: () => [...mounted!.root.querySelectorAll<HTMLDetailsElement>('#accordion > details')] }
}

// What the browser does when the reader opens or closes a section.
async function flip(section: HTMLDetailsElement) {
  click(section.querySelector('summary'))
  await settle()
}

test('CollapsibleSection tells onToggle when the reader folds it, and follows open when the app changes it', async () => {
  const { root, calls } = await mount()
  const section = root.querySelector<HTMLDetailsElement>('#section')!

  expect(section.open).toBe(false)
  expect(calls).toEqual([])

  click(root.querySelector('#open'))
  await settle()
  expect(section.open).toBe(true)
  expect(calls).toEqual(['toggle true'])

  await flip(section)
  expect(section.open).toBe(false)
  expect(calls).toEqual(['toggle true', 'toggle false'])
})

test('Accordion tells onChange the values open, and reports only the opening when it closes another', async () => {
  const { calls, sections } = await mount()

  await flip(sections()[0]!)
  expect(calls).toEqual(['change mars'])
  expect(sections().map(section => section.open)).toEqual([true, false, false])
})

test('Accordion with multiple tells every value open', async () => {
  const { calls, sections } = await mount({ multiple: true })

  await flip(sections()[0]!)
  await flip(sections()[1]!)
  await flip(sections()[0]!)
  expect(calls).toEqual(['change mars', 'change mars,venus', 'change venus'])
})

test('Accordion follows value when the app sets it', async () => {
  const { root, calls, sections } = await mount({ controlled: true })

  expect(sections().map(section => section.open)).toEqual([false, true, false])

  click(root.querySelector('#pick'))
  await settle()
  expect(sections().map(section => section.open)).toEqual([true, false, false])
  expect(calls).toEqual([])
})

test('Accordion draws a title block and an item meta, and a disabled item cannot be opened', async () => {
  const { sections } = await mount()
  const [mars, , earth] = sections() as [HTMLDetailsElement, HTMLDetailsElement, HTMLDetailsElement]

  expect(mars.querySelector('summary b')?.textContent).toBe('MARS')
  expect(mars.querySelector('summary')?.textContent).toContain('2 moons')
  expect(earth.querySelector('summary')?.getAttribute('aria-disabled')).toBe('true')

  expect(earth.querySelector('summary')?.getAttribute('tabindex')).toBe('-1')
})
