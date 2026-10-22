import type { Mounted } from 'kay/test'
import { afterEach, expect, spyOn, test } from 'bun:test'
import { mountComponent, settle } from 'kay/test'
import { click } from './dom'

let mounted: Mounted | undefined

afterEach(() => {
  mounted?.unmount()
})

async function open(onChange?: (value: string) => unknown) {
  mounted = await mountComponent('src/components/color-input.kay', { onChange })

  const root = mounted.root
  const input = root.querySelector<HTMLInputElement>('input[name="light"]')!
  const shown = () => input.closest('.kui-color-input')?.querySelector('.kui-color-input-value')?.textContent
  const drag = async (value: string) => {
    input.value = value
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await settle()
  }
  const commit = async (value: string) => {
    input.value = value
    input.dispatchEvent(new Event('input', { bubbles: true }))
    input.dispatchEvent(new Event('change', { bubbles: true }))
    await settle()
  }

  return { root, input, shown, drag, commit }
}

test('draws a native colour input named by its label, with the swatch value and the hex beside it', async () => {
  const { input, shown, root } = await open()

  expect([input.type, input.value, shown(), input.closest('.kui-color-input')?.querySelector('.kui-color-input-label')?.textContent]).toEqual(['color', '#ff8800', '#ff8800', 'Light'])
  expect(root.querySelector<HTMLInputElement>('input[name="locked"]')!.disabled).toBe(true)
})

test('posts its colour under its name in a form', async () => {
  const { root, commit } = await open()

  expect(new FormData(root.querySelector('form')!).get('light')).toBe('#ff8800')

  await commit('#123456')

  expect(new FormData(root.querySelector('form')!).get('light')).toBe('#123456')
})

test('follows the picker while it is dragged over, and tells onChange only what is committed', async () => {
  const told: string[] = []
  const { drag, commit, shown } = await open((value) => {
    told.push(value)
  })

  await drag('#111111')
  await drag('#222222')

  expect([told, shown()]).toEqual([[], '#222222'])

  await commit('#333333')

  expect([told, shown()]).toEqual([['#333333'], '#333333'])
})

test('follows a colour the parent sets', async () => {
  const { input, shown, root } = await open()

  click(root.querySelector('#set'))
  await settle()

  expect([input.value, shown(), root.querySelector('#state')?.textContent]).toEqual(['#00ff00', '#00ff00', '#00ff00'])
})

test('holds the input busy while the change is under way, opens no picker, and keeps an accepted colour', async () => {
  const gate = Promise.withResolvers<boolean>()
  const { input, commit, shown } = await open(async () => gate.promise)

  await commit('#abcdef')

  expect([input.getAttribute('aria-busy'), shown()]).toEqual(['true', '#abcdef'])

  const opened = new MouseEvent('click', { bubbles: true, cancelable: true })

  input.dispatchEvent(opened)
  expect(opened.defaultPrevented).toBe(true)

  gate.resolve(true)
  await settle()

  expect([input.getAttribute('aria-busy'), input.value, shown()]).toEqual([null, '#abcdef', '#abcdef'])
  expect(input.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))).toBe(true)
})

for (const [name, answer] of [['resolves to false', async () => Promise.resolve(false)], ['rejects', async () => Promise.reject(new Error('offline'))]] as const) {
  test(`puts the previous colour back when the change ${name}`, async () => {
    const error = spyOn(console, 'error').mockImplementation(() => undefined)
    const { input, commit, shown } = await open(answer)

    await commit('#abcdef')

    expect([input.value, shown(), input.getAttribute('aria-busy')]).toEqual(['#ff8800', '#ff8800', null])

    error.mockRestore()
  })
}

test('takes no new colour while busy, and puts the shown one back', async () => {
  const gate = Promise.withResolvers<boolean>()
  const told: string[] = []
  const { input, commit, drag, shown } = await open(async (value) => {
    told.push(value)

    return gate.promise
  })

  await commit('#abcdef')
  await drag('#999999')
  await commit('#888888')

  expect([told, input.value, shown()]).toEqual([['#abcdef'], '#abcdef', '#abcdef'])

  gate.resolve(true)
  await settle()
})

test('keeps the colour the parent set while a change was under way, even when that change is refused', async () => {
  const gate = Promise.withResolvers<boolean>()
  const { input, commit, shown, root } = await open(async () => gate.promise)

  await commit('#abcdef')
  click(root.querySelector('#set'))
  await settle()
  gate.resolve(false)
  await settle()

  expect([input.value, shown()]).toEqual(['#00ff00', '#00ff00'])
})

test('a form reset puts the colour back on its start and tells onChange', async () => {
  const told: string[] = []
  const { input, commit, root, shown } = await open((value) => {
    told.push(value)
  })

  await commit('#abcdef')
  click(root.querySelector('#reset'))
  await settle()

  expect([told, input.value, shown()]).toEqual([['#abcdef', '#ff8800'], '#ff8800', '#ff8800'])
})

test('a form reset meeting a change under way waits for it, then goes back', async () => {
  const gate = Promise.withResolvers<boolean>()
  const told: string[] = []
  const { input, commit, root } = await open(async (value) => {
    told.push(value)

    return told.length === 1 ? gate.promise : undefined
  })

  await commit('#abcdef')
  click(root.querySelector('#reset'))
  await settle()

  expect(told).toEqual(['#abcdef'])

  gate.resolve(true)
  await settle()

  expect([told, input.value]).toEqual([['#abcdef', '#ff8800'], '#ff8800'])
})
