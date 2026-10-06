import type { Mounted } from 'kay/test'
import type { IconChoice } from '../src/icon-picker'
import { afterEach, expect, test } from 'bun:test'
import { trustHtml } from 'kay'
import { mount, settle } from 'kay/test'
import { click } from './dom'

// Past the picker's debounce.
const TYPED_MS = 250

let mounted: Mounted | undefined
const changes: string[] = []
// Each search the picker ran, as [query, limit].
const searches: [string, number][] = []
const inputs: string[] = []
// The searches a test holds back, each answered once it calls `release`.
const held: { query: string, release: () => void }[] = []

afterEach(() => {
  mounted?.unmount()
  changes.length = 0
  searches.length = 0
  inputs.length = 0
  held.length = 0
})

function choice(name: string): IconChoice {
  return { name, icon: { 'viewBox': '0 0 24 24', 'width': '1em', 'height': '1em', 'aria-hidden': 'true', 'innerHTML': trustHtml(`<path data-icon="${name}"/>`) } }
}

const SET = ['tabler:home', 'tabler:house', ...Array.from({ length: 70 }, (_, index) => `tabler:shape-${index}`)].map(choice)

function found(query: string, limit: number): IconChoice[] {
  return SET.filter(entry => entry.name.includes(query)).slice(0, limit)
}

async function picker(options: { value?: string, hold?: (query: string) => boolean } = {}) {
  mounted = await mount('src/components/icon-picker.kay', {
    value: options.value,
    onChange: (name: string) => changes.push(name),
    search: async (query: string, limit: number) => {
      searches.push([query, limit])

      if (options.hold?.(query))
        await new Promise<void>(release => held.push({ query, release }))

      return found(query, limit)
    },
  })

  const { root } = mounted

  root.querySelector('form')!.addEventListener('input', (event) => {
    const { name, value } = event.target as HTMLInputElement

    inputs.push(`${name}=${value}`)
  })
  await settle()

  const search = root.querySelector<HTMLInputElement>('input[type="search"]')!
  const all = () => [...root.querySelectorAll('.kui-icon-grid-option')]

  return {
    root,
    search,
    names: () => all().map(option => option.getAttribute('aria-label')),
    option: (name: string) => all().find(option => option.getAttribute('aria-label') === name)!,
    pressed: () => all().filter(option => option.getAttribute('aria-pressed') === 'true').map(option => option.getAttribute('aria-label')),
    hidden: () => root.querySelector<HTMLInputElement>('input[type="hidden"]')!.value,
    selection: () => root.querySelector('.kui-icon-grid-selection'),
    more: () => root.querySelector('.kui-icon-grid-more'),
    empty: () => root.querySelector('.kui-icon-grid-empty')?.textContent,
  }
}

function type(input: HTMLInputElement, text: string) {
  input.value = text
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

test('picks an icon into the form, and picking it again or clearing it empties the field', async () => {
  const view = await picker()

  expect(searches).toEqual([['', 50]])
  expect(view.names()).toHaveLength(50)
  expect(view.selection()).toBeNull()

  click(view.option('house'))
  await settle()

  expect([view.pressed(), view.hidden(), changes, inputs]).toEqual([['house'], 'tabler:house', ['tabler:house'], ['icon=tabler:house']])
  expect(view.selection()!.textContent).toContain('house')
  expect(view.selection()!.querySelector('[data-icon="tabler:house"]')).not.toBeNull()

  click(view.option('house'))
  await settle()

  expect([view.pressed(), view.hidden(), changes.at(-1)]).toEqual([[], '', ''])
  expect(view.selection()).toBeNull()

  click(view.option('home'))
  await settle()
  click(view.selection()!.querySelector('.kui-icon-grid-clear'))
  await settle()

  expect([view.pressed(), view.hidden(), changes]).toEqual([[], '', ['tabler:house', '', 'tabler:home', '']])
  expect(inputs).toEqual(['icon=tabler:house', 'icon=', 'icon=tabler:home', 'icon='])
})

test('searches once the typing pauses, from the first page again', async () => {
  const view = await picker()

  click(view.more())
  await settle()

  expect(searches.at(-1)).toEqual(['', 100])
  expect(view.names()).toHaveLength(72)
  expect(view.more()).toBeNull()

  // The first run's pause, on the same empty search, keeps the pages shown.
  await Bun.sleep(TYPED_MS)

  expect(view.names()).toHaveLength(72)

  type(view.search, 'ho')
  await settle()
  type(view.search, 'hou')
  await settle()

  expect(searches).toHaveLength(2)

  await Bun.sleep(TYPED_MS)

  expect(searches.slice(2)).toEqual([['hou', 50]])
  expect(view.names()).toEqual(['house'])

  type(view.search, 'nothing')
  await Bun.sleep(TYPED_MS)

  expect([view.names(), view.empty()]).toEqual([[], 'No icons found.'])
})

test('keeps the last grid while a search is in flight, and drops a search a later one overtook', async () => {
  const view = await picker({ hold: query => query === 'shape' || query === 'home' })

  type(view.search, 'shape')
  await Bun.sleep(TYPED_MS)

  expect(view.names()).toHaveLength(50)
  expect(view.root.querySelector('.kui-icon-grid')!.getAttribute('aria-busy')).toBe('true')
  expect(view.names()[0]).toBe('home')

  type(view.search, 'home')
  await Bun.sleep(TYPED_MS)
  held.shift()!.release()
  await settle()

  expect(view.names()).toHaveLength(50)
  expect(view.root.querySelector('.kui-icon-grid')!.getAttribute('aria-busy')).toBe('true')

  held.shift()!.release()
  await settle()

  expect(view.names()).toEqual(['home'])
  expect(view.root.querySelector('.kui-icon-grid')!.hasAttribute('aria-busy')).toBe(false)
})

test('reads Searching… until the first search lands', async () => {
  const view = await picker({ hold: () => true })

  expect(view.empty()).toBe('Searching…')

  held.shift()!.release()
  await settle()

  expect(view.empty()).toBeUndefined()
  expect(view.names()).toHaveLength(50)
})

test('starts on the given icon, drawing it once a search finds it and after one no longer does', async () => {
  const view = await picker({ value: 'tabler:home' })

  expect([view.pressed(), view.hidden()]).toEqual([['home'], 'tabler:home'])
  expect(view.selection()!.querySelector('[data-icon="tabler:home"]')).not.toBeNull()

  click(view.option('house'))
  type(view.search, 'shape')
  await Bun.sleep(TYPED_MS)

  expect(view.selection()!.textContent).toContain('house')
  expect(view.selection()!.querySelector('[data-icon="tabler:house"]')).not.toBeNull()
})

test('follows an icon its parent passes', async () => {
  const view = await picker({ value: 'tabler:home' })

  click(view.root.querySelector('#choose'))
  await settle()

  expect([view.pressed(), view.hidden(), changes]).toEqual([['shape-3'], 'tabler:shape-3', []])
})

test('keeps Enter in the search box from submitting the form', async () => {
  const view = await picker()
  const enter = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
  const other = new KeyboardEvent('keydown', { key: 'a', bubbles: true, cancelable: true })

  view.search.dispatchEvent(enter)
  view.search.dispatchEvent(other)

  expect([enter.defaultPrevented, other.defaultPrevented]).toEqual([true, false])
})
