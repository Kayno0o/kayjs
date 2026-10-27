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

const radio = (root: Element, value: string) => click(root.querySelector(`#segmented input[value="${value}"]`))

async function choose(root: Element, value: string) {
  const select = root.querySelector<HTMLSelectElement>('#select')!

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
