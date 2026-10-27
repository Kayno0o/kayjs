import type { Mounted } from 'kay/test'
import { afterEach, expect, spyOn, test } from 'bun:test'
import { mountComponent, settle } from 'kay/test'
import ParamPickers from '../tests/fixture/src/components/param-pickers.kay'
import ParamTabs from '../tests/fixture/src/components/param-tabs.kay'
import { click } from './dom'

// The site is mounted under /docs and the page is its French one: every address a param control builds or goes to keeps both.
const meta = document.createElement('meta')

meta.name = 'kay-base'
meta.content = '/docs'
document.head.append(meta)

let mounted: Mounted | undefined

afterEach(() => {
  mounted?.unmount()
})

async function open(component: typeof ParamPickers | typeof ParamTabs, search: string) {
  ;(window as unknown as { happyDOM: { setURL: (url: string) => void } }).happyDOM.setURL(`http://localhost/docs/fr/traffic${search}`)
  mounted?.unmount()
  mounted = await mountComponent(component)

  return mounted.root
}

async function pick(search: string, act: (root: Element) => void): Promise<string | undefined> {
  const assign = spyOn(location, 'assign').mockImplementation(() => undefined)

  try {
    act(await open(ParamPickers, search))
    await settle()

    return (assign.mock.calls[0]?.[0] as URL | undefined)?.href.replace('http://localhost', '')
  }
  finally {
    assign.mockRestore()
  }
}

test('a Segmented with a param goes to the same page under the base and the locale', async () => {
  expect(await pick('?site=a', root => click(root.querySelector('#segmented input[value="30d"]')))).toBe('/docs/fr/traffic?site=a&period=30d')
  expect(await pick('?period=30d&site=a', root => click(root.querySelector('#segmented input[value="7d"]')))).toBe('/docs/fr/traffic?site=a')
})

test('a Select with a param does the same', async () => {
  const choose = (value: string) => (root: Element) => {
    const select = root.querySelector<HTMLSelectElement>('#select')!

    select.value = value
    select.dispatchEvent(new Event('change', { bubbles: true }))
  }

  expect(await pick('?site=a', choose('24h'))).toBe('/docs/fr/traffic?site=a&period=24h')
  expect(await pick('?period=24h', choose(''))).toBe('/docs/fr/traffic')
})

test('a TabNav of a param links to the page under the base and the locale, the other params kept', async () => {
  const root = await open(ParamTabs, '?tab=hosts&period=7d')

  expect([...root.querySelectorAll('#first a')].map(link => [link.getAttribute('href'), link.getAttribute('aria-current')])).toEqual([['/docs/fr/traffic?tab=findings&period=7d', null], ['/docs/fr/traffic?tab=hosts&period=7d', 'page'], ['/docs/fr/traffic?tab=ports&period=7d', null]])
})
