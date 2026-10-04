import type { Mounted } from 'kay/test'
import { afterEach, expect, test } from 'bun:test'
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
