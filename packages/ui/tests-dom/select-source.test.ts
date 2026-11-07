import type { Mounted } from 'kay/test'
import { afterEach, expect, test } from 'bun:test'
import { mountComponent, settle } from 'kay/test'
import SearchedSelect from '../tests/fixture/src/components/searched-select.kay'

let mounted: Mounted | undefined

afterEach(() => {
  mounted?.unmount()
})

const PLANETS = [{ value: 'mars', label: 'Mars' }, { value: 'moon', label: 'Moon' }, { value: 'earth', label: 'Earth' }]

async function mount(source: unknown) {
  const calls: string[] = []

  mounted = await mountComponent(SearchedSelect, { source, calls })

  const root = mounted.root
  const search = root.querySelector<HTMLInputElement>('#search')!
  const select = root.querySelector<HTMLSelectElement>('#planet')!
  const type = async (text: string) => {
    search.value = text
    search.dispatchEvent(new Event('input', { bubbles: true }))
    await settle()
  }
  const labels = () => [...select.options].map(option => option.textContent)

  return { calls, type, select, labels }
}

test('a Select asks a function once with an empty query, then again for each query it is given', async () => {
  const asked: string[] = []
  const { calls, type, labels } = await mount(async ({ q }: { q: string }) => {
    asked.push(q)

    return PLANETS.filter(planet => planet.label.toLowerCase().includes(q))
  })

  await settle()
  expect(labels()).toEqual(['Mars', 'Moon', 'Earth'])

  await type('mo')
  expect(labels()).toEqual(['Moon'])
  expect(asked).toEqual(['', 'mo'])
  expect(calls).toEqual(['load :3', 'load mo:1'])
})

test('a Select keeps only the latest answer when an older question lands after it', async () => {
  const waiting: { q: string, resolve: (answer: typeof PLANETS) => void }[] = []
  const { type, labels } = await mount(async ({ q }: { q: string }) => new Promise<typeof PLANETS>((resolve) => {
    waiting.push({ q, resolve })
  }))

  await type('a')
  expect(waiting.map(one => one.q)).toEqual(['', 'a'])

  waiting[1]!.resolve([PLANETS[0]!])
  await settle()
  waiting[0]!.resolve(PLANETS)
  await settle()

  expect(labels()).toEqual(['Mars'])
})

test('a Select draws a promise as its options and a source that fails says so with the query', async () => {
  const { labels } = await mount(Promise.resolve(PLANETS))

  await settle()
  expect(labels()).toEqual(['Mars', 'Moon', 'Earth'])

  mounted?.unmount()

  const failing = await mount(async () => Promise.reject(new Error('down')))

  await settle()
  expect(failing.labels()).toEqual(['Could not load the options'])
  expect(failing.calls).toEqual(['error '])
})
