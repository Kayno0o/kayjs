import type { Mounted } from 'kay/test'
import { afterEach, expect, jest, test } from 'bun:test'
import { mount, settle } from 'kay/test'
import { click } from './dom'

let mounted: Mounted | undefined

afterEach(() => {
  mounted?.unmount()
})

test('a toast shows in the toaster, an error as an alert, and leaves once dismissed', async () => {
  mounted = await mount('src/components/toasts.kay')
  click(mounted.root.querySelector('#saved'))
  click(mounted.root.querySelector('#refused'))
  await settle()

  const toasts = [...mounted.root.querySelectorAll('.toast')]

  expect(toasts.map(item => [item.getAttribute('role'), item.getAttribute('data-type'), item.querySelector('.toast-message')?.textContent])).toEqual([['status', 'success', 'Saved'], ['alert', 'error', 'Refused']])
  expect(mounted.root.querySelector('.toaster')?.matches(':popover-open')).toBe(true)

  click(toasts[0]!.querySelector('.toast-dismiss'))
  await settle()

  expect([...mounted.root.querySelectorAll('.toast-message')].map(item => item.textContent)).toEqual(['Refused'])
})

// Runs the timers due within `ms` of fake time, then lets the DOM updates they queued land.
async function elapse(ms: number) {
  jest.advanceTimersByTime(ms)
  await Promise.resolve()
}

test('the toasts hold while the pointer rests on them, and run out once it leaves', async () => {
  mounted = await mount('src/components/toasts.kay')
  const { root } = mounted
  const messages = () => [...root.querySelectorAll('.toast-message')].map(item => item.textContent)

  // The toasts a test before left, on a timer this test's fake clock does not run.
  for (const dismiss of root.querySelectorAll('.toast-dismiss'))
    click(dismiss)

  jest.useFakeTimers()

  try {
    click(root.querySelector('#saved'))
    await elapse(0)

    const toaster = root.querySelector('.toaster')!

    toaster.dispatchEvent(new PointerEvent('pointerenter'))
    await elapse(10_000)

    expect(messages()).toEqual(['Saved'])

    toaster.dispatchEvent(new PointerEvent('pointerleave'))
    await elapse(4000)

    expect(messages()).toEqual([])
  }
  finally {
    jest.useRealTimers()
  }
})
