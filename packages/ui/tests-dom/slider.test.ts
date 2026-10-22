import type { Mounted } from 'kay/test'
import { afterEach, expect, spyOn, test } from 'bun:test'
import { mountComponent, settle } from 'kay/test'
import { click } from './dom'

let mounted: Mounted | undefined

afterEach(() => {
  mounted?.unmount()
})

async function open(onInput?: (value: number) => void, onChange?: (value: number) => unknown) {
  mounted = await mountComponent('src/components/slider.kay', { onInput, onChange })

  const root = mounted.root
  const input = root.querySelector<HTMLInputElement>('input[name="delay"]')!
  const shown = () => root.querySelector('#delay')?.closest('.kui-slider')?.querySelector('.kui-slider-value')?.textContent
  const drag = async (value: string) => {
    input.value = value
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await settle()
  }

  // The pointer let go, or a key press: the browser fires `change` once the value is set.
  const release = async () => {
    input.dispatchEvent(new Event('change', { bubbles: true }))
    await settle()
  }

  return { root, input, shown, drag, release }
}

test('draws a native range input named by its label, holding the value and the bounds', async () => {
  const { input, root } = await open()

  expect([input.type, input.min, input.max, input.step, input.value, input.getAttribute('aria-label')]).toEqual(['range', '0', '100', '10', '40', 'Delay'])
  expect(root.querySelector('#delay')?.closest('.kui-slider')?.querySelector('.kui-slider-label')?.textContent).toBe('Delay')
})

test('shows the value through formatValue, and without it as the bare number', async () => {
  const { shown, root } = await open()

  expect(shown()).toBe('40 ms')
  expect(root.querySelector('#quiet')?.closest('.kui-slider')?.querySelector('.kui-slider-value')).toBeNull()
  expect(root.querySelector('#quiet')?.getAttribute('aria-valuetext')).toBeNull()
})

test('tells onInput the number while dragging and the shown value follows', async () => {
  const told: number[] = []
  const { drag, shown, root } = await open(value => told.push(value))

  await drag('70')

  expect([told, shown(), root.querySelector('#state')?.textContent]).toEqual([[70], '70 ms', '70'])
  expect(root.querySelector('#delay')?.getAttribute('aria-valuetext')).toBe('70 ms')
})

test('follows a value its parent sets', async () => {
  const { input, shown, root } = await open()

  click(root.querySelector('#set'))
  await settle()

  expect([input.value, shown()]).toEqual(['80', '80 ms'])
})

test('posts under its name in a plain form and goes back to its start on a reset', async () => {
  const { drag, root, shown } = await open()
  const form = root.querySelector<HTMLFormElement>('#form')!

  await drag('20')

  expect(new FormData(form).get('delay')).toBe('20')

  click(root.querySelector('#reset'))
  await new Promise(resolve => setTimeout(resolve, 30))
  await settle()

  expect([new FormData(form).get('delay'), shown()]).toEqual(['40', '40 ms'])
})

test('hands id, name and disabled to the input, and a disabled slider posts nothing', async () => {
  const { root } = await open()
  const locked = root.querySelector<HTMLInputElement>('#locked')!

  expect([locked.name, locked.disabled, new FormData(root.querySelector<HTMLFormElement>('#form')!).get('locked')]).toEqual(['locked', true, null])
})

test('tells onChange once with the value let go of, while onInput hears every step', async () => {
  const input: number[] = []
  const change: number[] = []
  const { drag, release, shown } = await open(value => input.push(value), value => void change.push(value))

  await drag('50')
  await drag('60')
  await drag('70')

  expect([input, change]).toEqual([[50, 60, 70], []])

  await release()

  expect([input, change, shown()]).toEqual([[50, 60, 70], [70], '70 ms'])

  // A key press steps the thumb and the browser fires `change` at once, which the two events here stand for.
  await drag('80')
  await release()

  expect(change).toEqual([70, 80])
})

test('holds the slider busy while onChange is pending, and ignores a gesture meanwhile', async () => {
  const settles: ((answer: boolean | undefined) => void)[] = []
  const { drag, release, input } = await open(undefined, async () => new Promise<boolean | undefined>(resolve => settles.push(resolve)))

  await drag('60')
  await release()

  expect(input.getAttribute('aria-busy')).toBe('true')

  const keydown = new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true })

  input.dispatchEvent(keydown)

  const tab = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })

  input.dispatchEvent(tab)

  expect([keydown.defaultPrevented, tab.defaultPrevented]).toEqual([true, false])

  // A move that got past the held gestures goes back and starts nothing.
  await drag('90')
  await release()

  expect(input.value).toBe('60')
  expect(settles.length).toBe(1)

  settles[0]!(undefined)
  await settle()

  expect([input.getAttribute('aria-busy'), input.value]).toEqual([null, '60'])
})

test('puts the thumb back when onChange resolves to false, rejects or throws', async () => {
  let answer: () => unknown = async () => Promise.resolve(false)
  const { drag, release, input, shown, root } = await open(undefined, () => answer())
  const logged = spyOn(console, 'error').mockImplementation(() => undefined)

  try {
    await drag('60')
    await release()

    expect([input.value, shown(), root.querySelector('#delay')?.getAttribute('aria-valuetext'), input.getAttribute('aria-busy')]).toEqual(['40', '40 ms', '40 ms', null])

    answer = async () => Promise.reject(new Error('offline'))
    await drag('60')
    await release()

    expect([input.value, shown()]).toEqual(['40', '40 ms'])

    answer = () => {
      throw new Error('broken')
    }
    await drag('90')
    await release()

    expect([input.value, shown(), logged.mock.calls.map(([, error]) => error as unknown)]).toEqual(['40', '40 ms', [new Error('offline'), new Error('broken')]])
    expect(root.querySelector('#state')?.textContent).toBe('40')
  }
  finally {
    logged.mockRestore()
  }
})

test('puts back the last accepted value, not the start, and leaves one its parent set meanwhile', async () => {
  let answer: () => unknown = () => undefined
  const settles: ((answer: boolean) => void)[] = []
  const { drag, release, input, root } = await open(undefined, () => answer())

  await drag('60')
  await release()

  answer = async () => new Promise<boolean>(resolve => settles.push(resolve))
  await drag('90')
  await release()
  settles[0]!(false)
  await settle()

  expect(input.value).toBe('60')

  await drag('20')
  await release()
  click(root.querySelector('#set'))
  await settle()
  settles[1]!(false)
  await settle()

  expect(input.value).toBe('80')
})

test('keeps the value the parent set to the very one pending, even when that change is refused', async () => {
  let settle1: (answer: boolean) => void = () => undefined
  const { release, input, root } = await open(undefined, async () => new Promise<boolean>((resolve) => {
    settle1 = resolve
  }))

  // Only `change` fires, so the parent has not heard the value yet.
  input.value = '80'
  await release()
  click(root.querySelector('#set'))
  await settle()
  settle1(false)
  await settle()

  expect(input.value).toBe('80')
})

test('still puts back a refused value the parent only echoed from onInput', async () => {
  const { drag, release, input } = await open(undefined, async () => Promise.resolve(false))

  await drag('60')
  await release()

  expect(input.value).toBe('40')
})

test('an app\'s aria-label wins over the label as the input\'s name', async () => {
  const { root } = await open()

  expect(root.querySelector('input[name="named"]')!.getAttribute('aria-label')).toBe('Pause between two sends')
})

test('keeps the value a parent set from inside onChange when that change is refused', async () => {
  let settle1: (answer: boolean) => void = () => undefined
  let page: HTMLElement | undefined
  const { release, input, root } = await open(undefined, async () => {
    click(page!.querySelector('#set'))

    return new Promise<boolean>((resolve) => {
      settle1 = resolve
    })
  })

  page = root
  input.value = '60'
  await release()
  settle1(false)
  await settle()

  expect(input.value).toBe('80')
})

test('tells onChange of a form reset that moved the thumb', async () => {
  const change: number[] = []
  const { drag, release, root, input } = await open(undefined, value => void change.push(value))

  await drag('20')
  await release()
  click(root.querySelector('#reset'))
  await new Promise(resolve => setTimeout(resolve, 30))
  await settle()

  expect([input.value, change]).toEqual(['40', [20, 40]])
})

test('keeps what the parent set during a change that was accepted', async () => {
  const settles: ((answer: boolean) => void)[] = []
  const { drag, release, input, root } = await open(undefined, async () => new Promise<boolean>(resolve => settles.push(resolve)))

  await drag('60')
  await release()
  click(root.querySelector('#set'))
  await settle()
  settles[0]!(true)
  await settle()

  expect(input.value).toBe('80')

  await drag('20')
  await release()
  settles[1]!(false)
  await settle()

  expect(input.value).toBe('80')
})
