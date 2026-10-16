import type { Mounted } from 'kay/test'
import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import { mount, settle } from 'kay/test'
import { click } from './dom'

let mounted: Mounted | undefined

afterEach(() => {
  mounted?.unmount()
})

const FIXTURE = 'src/components/pending.kay'

// How to drive one control of the fixture and read it back: `pick` changes it from `initial` to `picked`, `other` is another click on it, and `form` is what its field posts at each of the two.
interface Control {
  name: string
  // What `onChange` is told it by.
  reports: string
  initial: unknown
  picked: unknown
  form: [initial: unknown, picked: unknown]
  pick: (root: HTMLElement) => void
  other: (root: HTMLElement) => void
  read: (root: HTMLElement) => unknown
  // The element holding `aria-busy`.
  busy: (root: HTMLElement) => Element
  field: (data: FormData) => unknown
}

const input = (root: HTMLElement, selector: string) => root.querySelector<HTMLInputElement>(selector)!

const CONTROLS: Control[] = [
  {
    name: 'Checkbox',
    reports: 'checkbox',
    initial: false,
    picked: true,
    form: [null, 'on'],
    pick: root => click(input(root, 'input[name="agree"]')),
    other: root => click(input(root, 'input[name="agree"]')),
    read: root => input(root, 'input[name="agree"]').checked,
    busy: root => input(root, 'input[name="agree"]'),
    field: data => data.get('agree'),
  },
  {
    name: 'ChipGroup',
    reports: 'chips',
    initial: ['films'],
    picked: ['films', 'books'],
    form: [['films'], ['films', 'books']],
    pick: root => click(input(root, '#decks input[value="books"]')),
    other: root => click(input(root, '#decks input[value="films"]')),
    read: root => [...root.querySelectorAll<HTMLInputElement>('#decks input:checked')].map(box => box.value),
    busy: root => root.querySelector('#decks')!,
    field: data => data.getAll('decks'),
  },
  {
    name: 'Toggle',
    reports: 'toggle',
    initial: false,
    picked: true,
    form: [null, 'on'],
    pick: root => click(input(root, 'input[name="published"]')),
    other: root => click(input(root, 'input[name="published"]')),
    read: root => input(root, 'input[name="published"]').checked,
    busy: root => input(root, 'input[name="published"]'),
    field: data => data.get('published'),
  },
  {
    name: 'Segmented',
    reports: 'segmented',
    initial: 'private',
    picked: 'link',
    form: ['private', 'link'],
    pick: root => click(input(root, '#sharing input[value="link"]')),
    other: root => click(input(root, '#sharing input[value="public"]')),
    read: root => [...root.querySelectorAll<HTMLInputElement>('#sharing input')].find(radio => radio.checked)?.value,
    busy: root => root.querySelector('#sharing')!,
    field: data => data.get('sharing'),
  },
]

type Answer = boolean | Error | undefined
type Report = [control: string, value: unknown]

// The fixture with `onChange` answering through `answer`, and every call it heard.
async function open(answer: (control: string, value: unknown) => unknown, mirror = false) {
  const calls: Report[] = []

  mounted = await mount(FIXTURE, { mirror, onChange: (control: string, value: unknown) => {
    calls.push([control, value])

    return answer(control, value)
  } })

  return { root: mounted.root, calls }
}

// An `onChange` that answers with a promise the test settles by hand.
function held() {
  const settles: ((answer: Answer) => void)[] = []

  return { settles, answer: async () => new Promise<boolean | undefined>((resolve, reject) => settles.push(result => result instanceof Error ? reject(result) : resolve(result))) }
}

describe.each(CONTROLS)('$name', (control) => {
  test('submits like the field it is, and reports each change', async () => {
    const { root, calls } = await open(() => undefined)
    const fields = () => control.field(new FormData(root.querySelector('form')!))

    expect(fields()).toEqual(control.form[0])

    control.pick(root)
    await settle()

    expect(fields()).toEqual(control.form[1])
    expect(calls).toEqual([[control.reports, control.picked]])
  })

  test('is busy and takes no further change while one is under way, and goes back once it is refused', async () => {
    const { settles, answer } = held()
    const { root, calls } = await open(answer)
    const logged = spyOn(console, 'error').mockImplementation(() => undefined)
    const state = () => [control.read(root), control.busy(root).getAttribute('aria-busy')]
    const settleWith = async (result: Answer) => {
      settles.at(-1)!(result)
      await settle()
    }

    try {
      control.pick(root)
      await settle()
      control.other(root)
      await settle()

      // The change under way shows as made, and the click after it reached nothing.
      expect([state(), calls.length]).toEqual([[control.picked, 'true'], 1])

      await settleWith(false)

      expect(state()).toEqual([control.initial, null])

      control.pick(root)
      await settle()
      await settleWith(new Error('refused'))

      expect(state()).toEqual([control.initial, null])

      control.pick(root)
      await settle()
      await settleWith(undefined)

      expect(state()).toEqual([control.picked, null])
      expect(calls).toEqual([[control.reports, control.picked], [control.reports, control.picked], [control.reports, control.picked]])
      expect(logged.mock.calls.map(([, error]) => error as unknown)).toEqual([new Error('refused')])
    }
    finally {
      logged.mockRestore()
    }
  })

  test('goes back when onChange throws, and waits on any promise-like it answers', async () => {
    let answer: () => unknown = () => {
      throw new Error('offline')
    }
    const { root } = await open(() => answer())
    const logged = spyOn(console, 'error').mockImplementation(() => undefined)

    try {
      control.pick(root)
      await settle()

      expect([control.read(root), logged.mock.calls.map(([, error]) => error as unknown)]).toEqual([control.initial, [new Error('offline')]])

      // A promise-like of another library, not a `Promise`.
      answer = () => ({ then: (resolve: (value: boolean) => void) => resolve(false) })
      control.pick(root)
      await settle()

      expect(control.read(root)).toEqual(control.initial)
    }
    finally {
      logged.mockRestore()
    }
  })

  test('leaves the value its parent set while a refused change was under way', async () => {
    const { root } = await open(async () => Promise.reject(new Error('refused')), true)
    const logged = spyOn(console, 'error').mockImplementation(() => undefined)

    try {
      control.pick(root)
      await settle()
    }
    finally {
      logged.mockRestore()
    }

    expect(control.read(root)).toEqual(control.picked)
  })
})

test('a ChipGroup leaves its disabled chip alone', async () => {
  const { root, calls } = await open(() => undefined)

  click(root.querySelector('#decks input[value="music"]'))
  await settle()

  expect(calls).toEqual([])
})

test('a Checkbox is indeterminate while its parent says so, a click toggling it from checked', async () => {
  mounted = await mount(FIXTURE, { onChange: () => undefined })

  expect([...mounted.root.querySelectorAll('.kui-checkbox')].map(box => box.textContent)).toEqual(['I agreev2', 'Select all', 'Some'])

  const all = mounted.root.querySelector<HTMLInputElement>('#all')!
  const kept = mounted.root.querySelector<HTMLInputElement>('#kept')!

  expect([all.indeterminate, all.checked, kept.indeterminate]).toEqual([true, false, true])

  // A browser clears it on a click, which happy-dom does not.
  for (const box of [all, kept]) {
    box.indeterminate = false
    click(box)
  }
  await settle()

  expect([all.indeterminate, all.checked, kept.indeterminate, kept.checked]).toEqual([false, true, true, true])

  click(mounted.root.querySelector('#mix'))
  await settle()

  expect([all.indeterminate, all.checked]).toEqual([true, true])
})

test('a Segmented group shows none picked while its parent passes null, and again once the parent goes back to it', async () => {
  mounted = await mount(FIXTURE, { onChange: () => undefined })

  const radios = () => [...mounted!.root.querySelectorAll<HTMLInputElement>('#zoom input')].map(radio => radio.checked)

  expect(radios()).toEqual([false, false])

  click(mounted.root.querySelector('#zoom input[value="week"]'))
  await settle()

  expect(radios()).toEqual([false, true])

  click(mounted.root.querySelector('#unzoom'))
  await settle()

  expect(radios()).toEqual([false, false])
})
