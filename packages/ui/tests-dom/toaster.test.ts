import type { Mounted } from 'kay/test'
import { afterEach, expect, jest, test } from 'bun:test'
import { mountComponent, settle } from 'kay/test'
import { click } from './dom'

let mounted: Mounted | undefined

afterEach(() => {
  mounted?.unmount()
})

test('a toast shows in the toaster and is read from a region kept in the page, an error as an alert, and leaves once dismissed', async () => {
  mounted = await mountComponent('src/components/toasts.kay')
  click(mounted.root.querySelector('#saved'))
  click(mounted.root.querySelector('#refused'))
  await settle()

  const toasts = [...mounted.root.querySelectorAll('.kui-toast')]

  expect(toasts.map(item => [item.getAttribute('data-tone'), item.getAttribute('data-type'), item.querySelector('.kui-toast-message')?.textContent])).toEqual([['success', 'success', 'Saved'], ['danger', 'error', 'Refused']])
  expect([...mounted.root.querySelectorAll('.kui-toaster-live')].map(region => [region.getAttribute('role'), region.textContent])).toEqual([['status', 'Saved'], ['alert', 'Refused']])
  expect(mounted.root.querySelector('.kui-toaster')?.matches(':popover-open')).toBe(true)

  click(toasts[0]!.querySelector('.kui-toast-dismiss'))
  await settle()

  expect([...mounted.root.querySelectorAll('.kui-toast-message')].map(item => item.textContent)).toEqual(['Refused'])
})

// Runs the timers due within `ms` of fake time, then lets the DOM updates they queued land.
async function elapse(ms: number) {
  jest.advanceTimersByTime(ms)
  await Promise.resolve()
}

test('the toasts hold while the pointer rests on them, and run out once it leaves', async () => {
  mounted = await mountComponent('src/components/toasts.kay')
  const { root } = mounted
  const messages = () => [...root.querySelectorAll('.kui-toast-message')].map(item => item.textContent)

  // The toasts a test before left, on a timer this test's fake clock does not run.
  for (const dismiss of root.querySelectorAll('.kui-toast-dismiss'))
    click(dismiss)

  jest.useFakeTimers()

  try {
    click(root.querySelector('#saved'))
    await elapse(0)

    const toaster = root.querySelector('.kui-toaster')!

    toaster.dispatchEvent(new PointerEvent('pointerenter'))
    await elapse(10_000)

    expect(messages()).toEqual(['Saved'])

    toaster.dispatchEvent(new PointerEvent('pointerleave'))
    await elapse(6000)

    expect(messages()).toEqual([])
  }
  finally {
    jest.useRealTimers()
  }
})

test('an info toast is drawn in the info tone, and a sticky one stays until it is dismissed', async () => {
  mounted = await mountComponent('src/components/toasts.kay')
  const { root } = mounted
  const messages = () => [...root.querySelectorAll('.kui-toast-message')].map(item => item.textContent)

  for (const dismiss of root.querySelectorAll('.kui-toast-dismiss'))
    click(dismiss)

  jest.useFakeTimers()

  try {
    click(root.querySelector('#copied'))
    click(root.querySelector('#sticky'))
    await elapse(0)

    expect([...root.querySelectorAll('.kui-toast')].map(item => item.getAttribute('data-tone'))).toEqual(['info', 'info'])

    await elapse(60_000)

    expect(messages()).toEqual(['Stuck'])

    click(root.querySelector('.kui-toast-dismiss'))
    await elapse(0)

    expect(messages()).toEqual([])
  }
  finally {
    jest.useRealTimers()
  }
})

test('a second Toaster renders nothing while the first is mounted, and takes over once it unmounts', async () => {
  mounted = await mountComponent('src/components/hosts.kay')
  const { root } = mounted
  const toasters = () => [...root.querySelectorAll('.kui-toaster')]

  click(root.querySelector('#saved'))
  await settle()

  const [first] = toasters()

  expect(toasters()).toHaveLength(1)
  expect([...root.querySelectorAll('.kui-toast-message')].map(item => item.textContent)).toEqual(['Saved'])

  click(root.querySelector('#unmount'))
  await settle()

  expect(toasters()).toHaveLength(1)
  expect(toasters()[0]).not.toBe(first)
  expect(toasters()[0]?.matches(':popover-open')).toBe(true)
  expect([...root.querySelectorAll('.kui-toast-message')].map(item => item.textContent)).toEqual(['Saved'])
})

test('Alt+T moves focus to the toasts and Escape dismisses the focused one', async () => {
  mounted = await mountComponent('src/components/toasts.kay')
  click(mounted.root.querySelector('#saved'))
  click(mounted.root.querySelector('#refused'))
  await settle()
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 't', altKey: true, bubbles: true, cancelable: true }))
  await settle()

  expect(document.activeElement?.closest('.kui-toast')?.querySelector('.kui-toast-message')?.textContent).toBe('Saved')

  document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
  await settle()

  expect([...mounted.root.querySelectorAll('.kui-toast-message')].map(item => item.textContent)).toEqual(['Refused'])
})
