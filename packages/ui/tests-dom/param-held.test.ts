import type { Mounted } from 'kay/test'
import { afterEach, expect, test } from 'bun:test'
import { mountComponent, settle } from 'kay/test'
import ParamHeld from '../tests/fixture/src/components/param-held.kay'
import { click } from './dom'

let mounted: Mounted | undefined

afterEach(() => {
  mounted?.unmount()
})

async function open(search: string) {
  ;(window as unknown as { happyDOM: { setURL: (url: string) => void } }).happyDOM.setURL(`http://localhost/traffic${search}`)
  mounted?.unmount()
  mounted = await mountComponent(ParamHeld)
  await settle()

  return mounted.root
}

// The option the markup marks selected, which the browser reads as the select's start; none marks the first option.
const selected = (root: Element, id: string) => root.querySelector(`#${id} option[selected]`)?.getAttribute('value')
const checked = (root: Element, id: string) => root.querySelector<HTMLInputElement>(`#${id} input:checked`)?.value

test('a Select and a Segmented with a param and no value show the option the address names', async () => {
  const root = await open('?period=30d&range=24h')

  expect(selected(root, 'select')).toBe('30d')
  expect(checked(root, 'segmented')).toBe('30d')
  expect(selected(root, 'select-bare')).toBe('24h')
  expect(checked(root, 'segmented-bare')).toBe('24h')
})

test('paramDefault is shown while the param is left out', async () => {
  const root = await open('')

  expect(selected(root, 'select')).toBe('7d')
  expect(checked(root, 'segmented')).toBe('7d')
})

test('without a default, a param left out shows the first option or the empty one', async () => {
  const root = await open('')

  expect(selected(root, 'select-bare')).toBeUndefined()
  expect(checked(root, 'segmented-bare')).toBe('24h')
  expect(selected(root, 'select-empty')).toBeUndefined()
})

test('a param outside the options shows paramDefault, else the first option', async () => {
  const root = await open('?period=1y&range=1y')

  expect(selected(root, 'select')).toBe('7d')
  expect(checked(root, 'segmented')).toBe('7d')
  expect(selected(root, 'select-bare')).toBeUndefined()
  expect(checked(root, 'segmented-bare')).toBe('24h')
})

// A swap, a query write and a Back or Forward step all end on the address changing, which the links built by withQuery follow too.
test('a Segmented follows the address when it changes under it', async () => {
  const root = await open('?period=30d')

  click(root.querySelector('#go'))
  await settle()

  expect(checked(root, 'segmented')).toBe('24h')
})
