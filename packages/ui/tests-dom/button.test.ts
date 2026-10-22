import type { Mounted } from 'kay/test'
import { afterEach, expect, spyOn, test } from 'bun:test'
import { mountComponent, settle } from 'kay/test'
import { click } from './dom'

let mounted: Mounted | undefined

afterEach(() => {
  mounted?.unmount()
})

function later() {
  const settles: (() => void)[] = []

  return { settles, run: async () => new Promise<void>(resolve => settles.push(resolve)) }
}

function state(root: Element, id: string) {
  const button = root.querySelector<HTMLButtonElement>(`#${id}`)!

  return [button.getAttribute('aria-busy'), button.disabled]
}

test('a Button is busy and disabled alone until the promise its onClick returned settles', async () => {
  const save = later()

  mounted = await mountComponent('src/components/buttons.kay', { onSave: save.run, onSubmit: () => undefined })

  const root = mounted.root

  click(root.querySelector('#save'))
  await settle()
  click(root.querySelector('#save'))
  await settle()

  expect([state(root, 'save'), state(root, 'other'), save.settles.length]).toEqual([['true', true], [null, false], 1])

  save.settles[0]!()
  await settle()

  expect(state(root, 'save')).toEqual([null, false])
})

test('a Button comes back from a promise that rejects, logging it', async () => {
  const logged = spyOn(console, 'error').mockImplementation(() => undefined)

  try {
    mounted = await mountComponent('src/components/buttons.kay', { onSave: async () => {
      throw new Error('refused')
    }, onSubmit: () => undefined })
    click(mounted.root.querySelector('#save'))
    await settle()

    expect(state(mounted.root, 'save')).toEqual([null, false])
    expect(logged).toHaveBeenCalledTimes(1)
  }
  finally {
    logged.mockRestore()
  }
})

test('a submit Button is busy while its form\'s async onSubmit runs, and a plain one is not', async () => {
  const submit = later()

  mounted = await mountComponent('src/components/buttons.kay', { onSave: () => undefined, onSubmit: submit.run })

  const root = mounted.root

  click(root.querySelector('#plain'))
  click(root.querySelector('#send'))
  await settle()

  expect([state(root, 'send'), state(root, 'plain'), root.querySelector('#form')!.getAttribute('aria-busy')]).toEqual([['true', false], [null, false], 'true'])

  submit.settles[0]!()
  await settle()

  expect([state(root, 'send'), root.querySelector('#form')!.getAttribute('aria-busy')]).toEqual([[null, false], null])
})

test('a submit Button whose onSubmit answers at once never shows busy', async () => {
  mounted = await mountComponent('src/components/buttons.kay', { onSave: () => undefined, onSubmit: () => undefined })

  click(mounted.root.querySelector('#send'))
  await settle()

  expect(state(mounted.root, 'send')).toEqual([null, false])
})

test('an explicit busy prop wins, whether it is false or true', async () => {
  const save = later()

  mounted = await mountComponent('src/components/buttons.kay', { onSave: save.run, onSubmit: () => undefined, busy: false })

  const root = mounted.root

  click(root.querySelector('#forced'))
  await settle()

  expect(state(root, 'forced')).toEqual([null, false])

  click(root.querySelector('#forced'))
  await settle()

  expect(save.settles.length).toBe(2)

  mounted.unmount()
  mounted = await mountComponent('src/components/buttons.kay', { onSave: save.run, onSubmit: () => undefined, busy: true })

  expect(state(mounted.root, 'forced')).toEqual(['true', false])
})

test('a submit Button whose onClick answers a promise still submits its form, busy but not disabled', async () => {
  const save = later()
  const submits: number[] = []

  mounted = await mountComponent('src/components/buttons.kay', { onSave: save.run, onSubmit: () => submits.push(1) })

  const root = mounted.root

  click(root.querySelector('#sendAsync'))
  await settle()

  expect([state(root, 'sendAsync'), submits, save.settles.length]).toEqual([['true', false], [1], 1])

  click(root.querySelector('#sendAsync'))
  await settle()

  expect([submits, save.settles.length]).toEqual([[1], 1])
})

test('spinner={false} keeps the label and icon while the button is still busy and disabled until its promise settles', async () => {
  const save = later()

  mounted = await mountComponent('src/components/buttons.kay', { onSave: save.run, onSubmit: () => undefined })

  const root = mounted.root
  const quiet = root.querySelector<HTMLButtonElement>('#quiet')!

  click(quiet)
  await settle()
  click(quiet)
  await settle()

  expect([state(root, 'quiet'), quiet.querySelector('.kui-spinner'), quiet.textContent.trim(), quiet.getAttribute('data-spinner'), save.settles.length]).toEqual([['true', true], null, 'Quiet', 'off', 1])

  save.settles[0]!()
  await settle()

  expect(state(root, 'quiet')).toEqual([null, false])
})

test('spinner={false} on a static submit button marks it for the stylesheet, which then draws no spinner of its own', async () => {
  mounted = await mountComponent('src/components/buttons.kay', { onSave: () => undefined, onSubmit: () => undefined })

  const root = mounted.root

  expect([root.querySelector('#quietSubmit')!.getAttribute('data-spinner'), root.querySelector('#send')!.getAttribute('data-spinner')]).toEqual(['off', null])
})

test('pressed writes aria-pressed on a toggle button, true or false, and leaves a plain button without it', async () => {
  mounted = await mountComponent('src/components/buttons.kay', { onSave: () => undefined, onSubmit: () => undefined })

  const pressed = (id: string) => mounted!.root.querySelector(`#${id}`)!.getAttribute('aria-pressed')

  expect(['on', 'off', 'pressedAsync', 'other'].map(pressed)).toEqual(['true', 'false', 'true', null])
})

test('tone success draws the success button', async () => {
  mounted = await mountComponent('src/components/buttons.kay', { onSave: () => undefined, onSubmit: () => undefined })

  expect(mounted.root.querySelector('#success')!.className).toBe('kui-btn kui-btn-success')
})
