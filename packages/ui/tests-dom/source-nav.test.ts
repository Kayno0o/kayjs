import type { Mounted } from 'kay/test'
import { afterEach, expect, test } from 'bun:test'
import { mountComponent, settle } from 'kay/test'
import SourceNav from '../tests/fixture/src/components/source-nav.kay'

let mounted: Mounted | undefined

afterEach(() => {
  mounted?.unmount()
})

const TABS = [{ value: 'a', label: 'One' }, { value: 'b', label: 'Two' }]
const STEPS = [{ key: 'a', label: 'Cart' }, { key: 'b', label: 'Pay' }, { key: 'c', label: 'Done' }]

async function mount(tabs: () => Promise<typeof TABS>, steps: () => Promise<typeof STEPS>) {
  const calls: string[] = []

  mounted = await mountComponent(SourceNav, { tabs, steps, calls })

  const root = mounted.root
  const part = (id: string, name: string) => [...root.querySelectorAll(`#${id} [data-part=${name}]`)]

  return {
    calls,
    root,
    part,
    status: (id: string) => root.querySelector(`#${id} > [data-part=status]`)?.textContent,
    busy: (id: string) => root.querySelector(`#${id}`)!.getAttribute('aria-busy'),
  }
}

test('Tabs and Steps say loading, then draw the answer with the asked tab and step on screen', async () => {
  const resolvers: (() => void)[] = []
  const { calls, part, status, busy } = await mount(
    async () => new Promise<typeof TABS>(done => resolvers.push(() => done(TABS))),
    async () => new Promise<typeof STEPS>(done => resolvers.push(() => done(STEPS))),
  )

  for (const id of ['tabs', 'steps']) {
    expect(status(id)).toBe('Loading…')
    expect(busy(id)).toBe('true')
  }

  expect(part('tabs', 'tab')).toHaveLength(0)

  for (const resolve of resolvers)
    resolve()

  await settle()

  for (const id of ['tabs', 'steps']) {
    expect(status(id)).toBeUndefined()
    expect(busy(id)).toBeNull()
  }

  expect(part('tabs', 'tab').map(one => one.textContent)).toEqual(['One', 'Two'])
  expect(part('tabs', 'tab').map(one => one.getAttribute('aria-selected'))).toEqual(['false', 'true'])
  expect(part('tabs', 'panel').map(one => one.textContent)).toEqual(['a', 'b'])
  expect(part('steps', 'item').map(one => one.getAttribute('data-step'))).toEqual(['done', 'current', 'upcoming'])
  expect(calls).toEqual(['tabs 2:', 'steps 3'])
})

test('a source that rejects says so on both, and onError hears the query', async () => {
  const { calls, part, status } = await mount(async () => Promise.reject(new Error('down')), async () => Promise.reject(new Error('down')))

  await settle()

  expect(status('tabs')).toBe('Could not load the tabs')
  expect(status('steps')).toBe('Could not load the steps')
  expect(part('tabs', 'tab')).toHaveLength(0)
  expect(part('steps', 'item')).toHaveLength(0)
  expect(calls).toEqual(['tabs error '])
})

test('the retry button asks the function again, and the answer replaces the failure', async () => {
  let asked = 0
  const { part, status } = await mount(async () => {
    asked++

    return asked === 1 ? Promise.reject(new Error('down')) : TABS
  }, async () => STEPS)

  await settle()
  expect(status('tabs')).toBe('Could not load the tabs')

  part('tabs', 'retry')[0]!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  await settle()

  expect(asked).toBe(2)
  expect(status('tabs')).toBeUndefined()
  expect(part('tabs', 'tab')).toHaveLength(2)
})

test('the arrow keys move over loaded tabs', async () => {
  const { part } = await mount(async () => TABS, async () => STEPS)

  await settle()

  part('tabs', 'list')[0]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }))
  await settle()

  expect(part('tabs', 'tab').map(one => one.getAttribute('aria-selected'))).toEqual(['true', 'false'])
})

test('a plain list draws at once, with no loading state', async () => {
  mounted = await mountComponent(SourceNav, { tabs: TABS, steps: STEPS, calls: [] })

  const root = mounted.root

  expect(root.querySelector('#tabs')!.getAttribute('aria-busy')).toBeNull()
  expect(root.querySelectorAll('#tabs [data-part=tab]')).toHaveLength(2)
  expect(root.querySelectorAll('#steps [data-part=item]')).toHaveLength(3)
  expect(root.querySelector('[data-part=status]')).toBeNull()
})
