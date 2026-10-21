import type { Mounted } from 'kay/test'
import type { ScreenCollection, StoredEntry } from '../src/kay/contract'
import { afterEach, expect, mock, spyOn, test } from 'bun:test'
import { mountComponent, settle } from 'kay/test'

const SHOP: ScreenCollection = {
  name: 'shop',
  kind: 'folder',
  localized: false,
  components: [],
  schema: {
    type: 'object',
    properties: {
      accent: { 'type': 'string', 'x-kay': { kind: 'hex-color' } },
      labels: { 'type': 'array', 'items': { type: 'string' }, 'x-kay': { kind: 'tag-list' } },
      icon: { 'type': 'string', 'x-kay': { kind: 'icon-name', set: 'mini' } },
      opens: { type: 'string', format: 'date' },
      starts: { type: 'string', format: 'date-time' },
      size: { anyOf: Array.from({ length: 14 }, (_, at) => ({ const: `size-${at}`, title: `Size ${at}` })) },
      address: { type: 'object', properties: { street: { type: 'string' }, city: { type: 'string' } } },
    },
  },
}
const entry = (data: Record<string, unknown>) => ({ slug: 'one', locale: undefined, data, draft: false, version: 'v1', url: '/shop/one' }) as unknown as StoredEntry
let mounted: Mounted | undefined

afterEach(() => {
  mounted?.unmount()
  mounted = undefined
  mock.restore()
})

async function open(data: Record<string, unknown> = {}, collection: ScreenCollection = SHOP) {
  // The icon picker asks for its first page as soon as it is drawn.
  if (!('mock' in globalThis.fetch))
    spyOn(globalThis, 'fetch').mockImplementation((async () => Response.json([])) as unknown as typeof fetch)

  mounted = await mountComponent('src/components/entry-screen.kay', { collection, entry: entry(data) })
  await settle()

  const root = mounted.root
  const field = (path: string) => root.querySelector<HTMLElement>(`[data-kcms-path="${path}"]`)!
  const type = async (input: HTMLInputElement, text: string) => {
    input.value = text
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await settle()
  }
  const save = async () => {
    const fetched = spyOn(globalThis, 'fetch').mockImplementation((async (url: RequestInfo | URL) => Response.json(String(url).includes('/entries/') ? { saved: true, version: 'v2' } : [])) as unknown as typeof fetch)

    root.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))

    for (let wait = 0; wait < 30; wait++) {
      await Bun.sleep(10)
      await settle()
    }

    const saved = fetched.mock.calls.find(([url]) => String(url).includes('/entries/'))

    return (JSON.parse(String((saved![1] as RequestInit).body)) as { data: Record<string, unknown> }).data
  }

  return { root, field, type, save }
}

test('a colour is picked or typed and saved in the code the schema asks for', async () => {
  const { field, type, save } = await open({ accent: '#112233' })
  const [swatch, code] = field('accent').querySelectorAll<HTMLInputElement>('input')

  expect(swatch!.type).toBe('color')
  expect(swatch!.value).toBe('#112233')
  expect(code!.value).toBe('#112233')

  await type(swatch!, '#ff0000')
  expect(code!.value).toBe('#ff0000')
  expect((await save()).accent).toBe('#ff0000')
})

test('tags are typed one by one or comma separated, never twice, and removed one at a time', async () => {
  const { field, type, save } = await open({ labels: ['a'] })
  const box = field('labels').querySelector<HTMLInputElement>('input')!
  const press = async (key: string) => {
    box.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
    await settle()
  }
  const chips = () => [...field('labels').querySelectorAll('.kcms-tag')].map(chip => chip.textContent?.trim())

  await type(box, 'b, c ,a,')
  await press('Enter')
  expect(chips()).toEqual(['a', 'b', 'c'])

  await press('Backspace')
  expect(chips()).toEqual(['a', 'b'])

  field('labels').querySelector<HTMLButtonElement>('.kcms-tag button')!.click()
  await settle()
  expect(chips()).toEqual(['b'])
  expect((await save()).labels).toEqual(['b'])
})

test('an icon field asks the server for the icons of its set and keeps the one picked', async () => {
  const asked: string[] = []

  spyOn(globalThis, 'fetch').mockImplementation((async (input: RequestInfo | URL) => {
    asked.push(String(input))

    return Response.json([{ name: 'mini:home', icon: { 'viewBox': '0 0 16 16', 'width': '1em', 'height': '1em', 'aria-hidden': 'true', 'innerHTML': '<path d="M0 0h1"/>' } }])
  }) as unknown as typeof fetch)

  const { field } = await open({})

  for (let wait = 0; wait < 20 && field('icon').querySelector('.kui-icon-grid-option') === null; wait++)
    await Bun.sleep(10)

  expect(asked[0]).toContain('set=mini')
  field('icon').querySelector<HTMLButtonElement>('.kui-icon-grid-option')!.click()
  await settle()
  expect(field('icon').querySelector('.kui-icon-grid-selection')?.textContent).toContain('home')
})

test('a date has Today and Clear, a date and time Now and Clear', async () => {
  const { field, save } = await open({ opens: '2020-01-02' })
  const named = (path: string, name: string) => [...field(path).querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent?.trim() === name)

  named('opens', 'Today')!.click()
  await settle()
  expect(field('opens').querySelector<HTMLInputElement>('input')!.value).toBe(new Date().toLocaleDateString('sv'))

  named('opens', 'Clear')!.click()
  await settle()
  expect(named('opens', 'Clear')).toBeUndefined()

  named('starts', 'Now')!.click()
  await settle()
  expect(field('starts').querySelector<HTMLInputElement>('input')!.value).not.toBe('')
  named('starts', 'Clear')!.click()
  await settle()
  expect((await save()).opens).toBeUndefined()
})

test('a pick among many options has a search box narrowing them, the option held always kept', async () => {
  const { field, type } = await open({ size: 'size-13' })
  const options = () => [...field('size').querySelectorAll('option')].map(option => option.textContent)

  expect(options()).toHaveLength(15)
  await type(field('size').querySelector<HTMLInputElement>('input[type="search"]')!, 'size 2')
  expect(options()).toEqual(['', 'Size 2', 'Size 13'])
})

test('a nested field the layout places is edited at its dotted path, the group keeping the others', async () => {
  const { root, field, type, save } = await open({ address: { street: 'Rue 1', city: 'Lyon' } }, { ...SHOP, layout: { form: { fields: [['address.city', 'accent']], hide: ['icon', 'labels', 'opens', 'starts', 'size'] } } })
  const rows = [...root.querySelectorAll('.kcms-row')].map(row => [...row.querySelectorAll('[data-kcms-path]')].map(found => found.getAttribute('data-kcms-path')).filter(path => path !== 'address.street' || row.querySelectorAll('[data-kcms-path]').length > 1))

  expect(rows[0]).toEqual(['address.city', 'accent'])
  expect(field('address').querySelector('[data-kcms-path="address.city"]')).toBeNull()
  await type(field('address.city').querySelector<HTMLInputElement>('input')!, 'Paris')
  expect((await save()).address).toEqual({ street: 'Rue 1', city: 'Paris' })
})
