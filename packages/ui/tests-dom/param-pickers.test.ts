import type { Mounted } from 'kay/test'
import { afterEach, expect, spyOn, test } from 'bun:test'
import { mountComponent, settle } from 'kay/test'
import ParamPickers from '../tests/fixture/src/components/param-pickers.kay'
import { click } from './dom'

let mounted: Mounted | undefined

afterEach(() => {
  mounted?.unmount()
})

// The address the page was left on after a pick: the page is loaded from it, as a pick on a page without the swap does.
async function pick(search: string, act: (root: Element) => void | Promise<void>): Promise<string | undefined> {
  ;(window as unknown as { happyDOM: { setURL: (url: string) => void } }).happyDOM.setURL(`http://localhost/traffic${search}`)

  const assign = spyOn(location, 'assign').mockImplementation(() => undefined)

  try {
    mounted?.unmount()
    mounted = await mountComponent(ParamPickers)
    await act(mounted.root)
    await settle()

    return (assign.mock.calls[0]?.[0] as URL | undefined)?.href.replace('http://localhost', '')
  }
  finally {
    assign.mockRestore()
  }
}

const radio = (root: Element, value: string, id = 'segmented') => click(root.querySelector(`#${id} input[value="${value}"]`))

async function choose(root: Element, value: string, id = 'select') {
  const select = root.querySelector<HTMLSelectElement>(`#${id}`)!

  select.value = value
  select.dispatchEvent(new Event('change', { bubbles: true }))
}

test('a Segmented with a param goes to the page with the option set, the other params kept', async () => {
  expect(await pick('?site=a&page=3', root => radio(root, '30d'))).toBe('/traffic?site=a&page=3&period=30d')
})

test('a Segmented leaves the param out for its default and replaces a value it had', async () => {
  expect(await pick('?period=30d&site=a', root => radio(root, '7d'))).toBe('/traffic?site=a')
  expect(await pick('?period=30d&site=a', root => radio(root, '24h'))).toBe('/traffic?period=24h&site=a')
})

test('a Select with a param does the same, and leaves the param out for the empty option', async () => {
  expect(await pick('?site=a', async root => choose(root, '24h'))).toBe('/traffic?site=a&period=24h')
  expect(await pick('?period=24h&site=a', async root => choose(root, '7d'))).toBe('/traffic?site=a')
  expect(await pick('?period=24h', async root => choose(root, ''))).toBe('/traffic')
})

test('both take the param as their name, for a GET form around them', async () => {
  await pick('', () => undefined)

  expect(mounted!.root.querySelector('#select')?.getAttribute('name')).toBe('period')
  expect(mounted!.root.querySelector('#segmented input')?.getAttribute('name')).toBe('period')
})

test('a number option equal to a text paramDefault leaves the param out', async () => {
  expect(await pick('?size=10', async root => choose(root, '25', 'sizes'))).toBe('/traffic')
  expect(await pick('', async root => choose(root, '10', 'sizes'))).toBe('/traffic?size=10')
})

test('an onChange answering false stops the move and puts the pick back', async () => {
  expect(await pick('?period=30d', root => radio(root, '24h', 'refused'))).toBeUndefined()
  expect(mounted!.root.querySelector<HTMLInputElement>('#refused input:checked')?.value).toBe('30d')

  expect(await pick('?period=30d', async root => choose(root, '24h', 'refused-select'))).toBeUndefined()
  expect(mounted!.root.querySelector<HTMLSelectElement>('#refused-select')?.value).toBe('30d')
})

test('a refused Select move puts back the value the app renders now, not the one read when the pick arrived', async () => {
  expect(await pick('?period=7d', async root => choose(root, '24h', 'stale'))).toBeUndefined()
  expect(mounted!.root.querySelector<HTMLSelectElement>('#stale')?.value).toBe('30d')
})

test('a RadioGroup with a param does what a Segmented does: the option set, the default left out, the param as its name', async () => {
  expect(await pick('?site=a', root => radio(root, '30d', 'radios'))).toBe('/traffic?site=a&period=30d')
  expect(await pick('?period=30d&site=a', root => radio(root, '7d', 'radios'))).toBe('/traffic?site=a')
  expect(mounted!.root.querySelector('#radios input')?.getAttribute('name')).toBe('period')
  expect(await pick('?period=30d', root => radio(root, '24h', 'refused-radios'))).toBeUndefined()
  expect(mounted!.root.querySelector<HTMLInputElement>('#refused-radios input:checked')?.value).toBe('30d')
})

test('a RadioGroup shows the option the address names, else its default', async () => {
  await pick('?period=30d', () => undefined)
  expect(mounted!.root.querySelector<HTMLInputElement>('#radios input:checked')?.value).toBe('30d')

  await pick('', () => undefined)
  expect(mounted!.root.querySelector<HTMLInputElement>('#radios input:checked')?.value).toBe('7d')
})

test('a ChipGroup with a param sets it once per picked option, the others kept, and leaves it out for none or its default', async () => {
  expect(await pick('?site=a', root => radio(root, '24h', 'chips'))).toBe('/traffic?site=a&range=24h&range=7d')
  expect(await pick('?range=7d&range=30d', root => radio(root, '30d', 'chips'))).toBe('/traffic')
  expect(await pick('?range=24h', root => radio(root, '24h', 'chips'))).toBe('/traffic')
  expect(mounted!.root.querySelector('#chips input')?.getAttribute('name')).toBe('range')
})

test('a ChipGroup shows the options the address names, else its default, and a refused pick is put back', async () => {
  await pick('?range=24h&range=30d', () => undefined)
  expect([...mounted!.root.querySelectorAll<HTMLInputElement>('#chips input:checked')].map(box => box.value)).toEqual(['24h', '30d'])

  await pick('', () => undefined)
  expect([...mounted!.root.querySelectorAll<HTMLInputElement>('#chips input:checked')].map(box => box.value)).toEqual(['7d'])

  expect(await pick('?range=30d', root => radio(root, '24h', 'refused-chips'))).toBeUndefined()
  expect([...mounted!.root.querySelectorAll<HTMLInputElement>('#refused-chips input:checked')].map(box => box.value)).toEqual(['30d'])
})
