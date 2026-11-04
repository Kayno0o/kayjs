import type { Mounted } from 'kay/test'
import { afterEach, expect, test } from 'bun:test'
import { mountComponent, settle } from 'kay/test'
import PropsFollow from '../tests/fixture/src/components/props-follow.kay'
import { click } from './dom'

// Every library component whose props a parent can change after render shows the change: the page flips them all with one button, and each test reads one component before and after.
document.documentElement.lang = 'en'

let mounted: Mounted | undefined

afterEach(() => {
  mounted?.unmount()
  mounted = undefined
})

async function flip(read: (root: ParentNode) => unknown) {
  mounted = await mountComponent(PropsFollow, {})

  const before = read(mounted.root)

  click(mounted.root.querySelector('#go'))
  await settle()

  return { before, after: read(mounted.root) }
}

function box(id: string) {
  return (root: ParentNode) => {
    const element = root.querySelector<HTMLInputElement>(`#${id} :is(input, textarea, select)`)!

    return { value: element.value, invalid: element.getAttribute('aria-invalid'), label: element.getAttribute('aria-label'), placeholder: element.getAttribute('placeholder'), disabled: element.disabled }
  }
}

const VALUES = { text: ['one', 'two'], area: ['one', 'two'], select: ['a', 'b'], slider: ['3', '8'], color: ['#000000', '#ff0000'], time: ['08:00', '10:30'], date: ['2026-01-02', '2026-02-03'], datetime: ['2026-01-02T08:00', '2026-02-03T10:30'] } as const

for (const [id, [start, end]] of Object.entries(VALUES)) {
  test(`${id} follows value, invalid and the attributes the parent changes`, async () => {
    const { before, after } = await flip(box(id)) as { before: ReturnType<ReturnType<typeof box>>, after: ReturnType<ReturnType<typeof box>> }

    expect(before.value).toBe(start)
    expect(after.value).toBe(end)
    expect(before.invalid).not.toBe('true')
    expect(after.invalid).toBe('true')
    expect(after.disabled).toBe(true)

    if (['text', 'area', 'select', 'time', 'date', 'datetime'].includes(id))
      expect(after.label).toBe('Later')

    if (['text', 'area'].includes(id))
      expect(after.placeholder).toBe('later')
  })
}

test('rating follows value and invalid', async () => {
  const { before, after } = await flip(root => ({ checked: [...root.querySelectorAll<HTMLInputElement>('#rating input')].findIndex(input => input.checked), invalid: root.querySelector('#rating [aria-invalid]')?.getAttribute('aria-invalid') })) as { before: { checked: number, invalid: string }, after: { checked: number, invalid: string } }

  expect(after.checked).not.toBe(before.checked)
  expect(after.invalid).toBe('true')
})

test('breadcrumb follows the length of its items', async () => {
  const { before, after } = await flip(root => root.querySelectorAll('#crumbs [data-part="item"]').length)

  expect(before).toBe(2)
  expect(after).toBe(5)
})

test('breadcrumb marks the middle of a trail that grows past three items, and the current page at its new end', async () => {
  const { before, after } = await flip(root => ({ middle: root.querySelectorAll('#crumbs [data-middle]').length, current: root.querySelector('#crumbs [aria-current]')?.textContent?.trim() }))

  expect(before).toEqual({ middle: 0, current: 'Page 1' })
  expect(after).toEqual({ middle: 2, current: 'Page 4' })
})

test('pagination follows the number of pages', async () => {
  const { before, after } = await flip(root => [...root.querySelectorAll('#pages a')].map(link => link.textContent?.trim()))

  expect(before).toContain('3')
  expect(before).not.toContain('9')
  expect(after).toContain('9')
})

test('form field follows hint and required', async () => {
  const { before, after } = await flip(root => ({ described: root.querySelector('#field-input')!.getAttribute('aria-describedby'), required: root.querySelector('#field-input')!.getAttribute('aria-required'), star: root.querySelector('#field [aria-hidden]') !== null }))
  const was = before as { described: string | null, required: string | null, star: boolean }
  const now = after as { described: string | null, required: string | null, star: boolean }

  expect(was.described).toBeNull()
  expect(now.described).not.toBeNull()
  expect(was.required).toBeNull()
  expect(now.required).toBe('true')
  expect(now.star).toBe(true)
})

test('page section follows sticky', async () => {
  const { before, after } = await flip(root => root.querySelector('#section [data-sticky]') !== null)

  expect(before).toBe(false)
  expect(after).toBe(true)
})

test('relative time follows its options', async () => {
  const { before, after } = await flip(root => root.querySelector('#time-ago time')!.textContent)

  expect(after).not.toBe(before)
})
