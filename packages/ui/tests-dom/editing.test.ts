import { afterEach, expect, test } from 'bun:test'
import { mount, settle } from 'kay/test'
import { click } from './dom'

let unmount: (() => void) | undefined

afterEach(() => {
  unmount?.()
})

test('editing opens one dialog on a row or a draft, and forgets it once the dialog closes', async () => {
  const mounted = await mount('src/components/editing.kay')
  const dialog = mounted.root.querySelector<HTMLDialogElement>('#friend')!
  const state = () => [dialog.open, dialog.querySelector('.kui-dialog-title')?.textContent, dialog.querySelector('#name')?.textContent]

  unmount = mounted.unmount

  click(mounted.root.querySelector('#edit-2'))
  await settle()

  expect(state()).toEqual([true, 'Edit friend', 'Grace'])

  click(mounted.root.querySelector('#add'))
  await settle()

  expect(state()).toEqual([true, 'Add friend', 'New friend'])

  // As Escape closes it.
  dialog.close()
  await settle()

  expect(state()).toEqual([false, undefined, undefined])
})
