import type { Mounted } from 'kay/test'
import { afterEach, expect, test } from 'bun:test'
import { mountComponent, settle } from 'kay/test'
import SourceGroups from '../tests/fixture/src/components/source-groups.kay'

let mounted: Mounted | undefined

afterEach(() => {
  mounted?.unmount()
})

const PLANS = [{ value: 'a', label: 'Free' }, { value: 'b', label: 'Pro' }]

async function mount(source: () => Promise<typeof PLANS>) {
  const calls: string[] = []

  mounted = await mountComponent(SourceGroups, { source, calls })

  const root = mounted.root
  const group = (id: string) => root.querySelector(`#${id}`)!
  const labels = (id: string) => [...group(id).querySelectorAll('[data-part=label]')].map(one => one.textContent)
  const status = (id: string) => group(id).querySelector('[data-part=status]')?.textContent
  const checked = (id: string) => [...group(id).querySelectorAll<HTMLInputElement>('input')].filter(one => one.checked).map(one => one.value)

  return { calls, group, labels, status, checked }
}

test('RadioGroup, Segmented and ChipGroup say loading, then draw the answer with the first option and the given value picked', async () => {
  const resolvers: ((answer: typeof PLANS) => void)[] = []
  const { calls, group, labels, status, checked } = await mount(async () => new Promise<typeof PLANS>((done) => {
    resolvers.push(done)
  }))

  for (const id of ['radios', 'segments', 'chips']) {
    expect(status(id)).toBe('Loading…')
    expect(group(id).getAttribute('aria-busy')).toBe('true')
  }

  for (const resolve of resolvers)
    resolve(PLANS)

  await settle()

  for (const id of ['radios', 'segments', 'chips']) {
    expect(labels(id)).toEqual(['Free', 'Pro'])
    expect(status(id)).toBeUndefined()
    expect(group(id).getAttribute('aria-busy')).toBeNull()
  }

  expect(checked('radios')).toEqual(['a'])
  expect(checked('segments')).toEqual(['a'])
  expect(checked('chips')).toEqual(['b'])
  expect(calls).toEqual(['radios 2:'])
})

test('a source that rejects says so, and onError hears the query', async () => {
  const { calls, status, labels } = await mount(async () => Promise.reject(new Error('down')))

  await settle()

  for (const id of ['radios', 'segments', 'chips']) {
    expect(status(id)).toBe('Could not load the options')
    expect(labels(id)).toEqual([])
  }

  expect(calls).toEqual(['radios error '])
})

test('the retry button of a failed group asks the function again, and the answer replaces the failure', async () => {
  let asked = 0
  const { group, labels, status } = await mount(async () => {
    asked++

    return asked <= 3 ? Promise.reject(new Error('down')) : PLANS
  })

  await settle()
  expect(status('radios')).toBe('Could not load the options')

  group('radios').querySelector<HTMLButtonElement>('[data-part=retry]')!.click()
  await settle()

  expect(asked).toBe(4)
  expect(labels('radios')).toEqual(['Free', 'Pro'])
  expect(status('radios')).toBeUndefined()
})
