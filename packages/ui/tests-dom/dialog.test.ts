import type { Mounted } from 'kay/test'
import { afterEach, describe, expect, test } from 'bun:test'
import { mount, settle } from 'kay/test'
import { click } from './dom'

let mounted: Mounted | undefined
let closes = 0

afterEach(() => {
  mounted?.unmount()
  closes = 0
})

async function dialogs(onDelete: () => Promise<void> = async () => Promise.resolve(), dirty = false) {
  mounted = await mount('src/components/dialogs.kay', { onClose: () => closes++, onDelete, dirty })

  return mounted.root
}

describe('Dialog', () => {
  test('opens as a modal holding its title and content, which it drops once closed', async () => {
    const root = await dialogs()
    const dialog = root.querySelector<HTMLDialogElement>('#dialog')!

    expect(dialog.open).toBe(false)
    expect(dialog.querySelector('#name')).toBeNull()

    click(root.querySelector('#open'))
    await settle()

    expect(dialog.open).toBe(true)
    expect(dialog.querySelector('.kui-dialog-title')?.textContent).toBe('Rename')
    expect(dialog.getAttribute('aria-label')).toBe('Rename')
    expect(dialog.querySelector('.kui-dialog-footer #cancel')).not.toBeNull()

    click(root.querySelector('#cancel'))
    await settle()

    expect(dialog.open).toBe(false)
    expect(dialog.querySelector('#name')).toBeNull()
    expect(closes).toBe(1)
  })

  test('holds against a click outside or Escape once something was typed, until it closes', async () => {
    const root = await dialogs()
    const dialog = root.querySelector<HTMLDialogElement>('#dialog')!

    click(root.querySelector('#open'))
    await settle()

    expect(dialog.getAttribute('closedby')).toBe('any')

    dialog.querySelector('#name')!.dispatchEvent(new Event('input', { bubbles: true }))
    await settle()

    expect(dialog.getAttribute('closedby')).toBe('none')

    click(root.querySelector('#cancel'))
    await settle()

    expect(dialog.getAttribute('closedby')).toBe('any')
  })

  test('holds while its parent says it is dirty', async () => {
    const root = await dialogs(undefined, true)

    expect(root.querySelector('#dialog')?.getAttribute('closedby')).toBe('none')
  })
})

describe('ConfirmDelete', () => {
  test('asks first, disables both buttons while the delete runs, and closes once it went through', async () => {
    const { promise, resolve: finish } = Promise.withResolvers<void>()
    const root = await dialogs(async () => promise)
    const trigger = root.querySelector('.kui-icon-btn[aria-label="Delete"]')
    const dialog = () => root.querySelectorAll<HTMLDialogElement>('dialog')[1]!

    click(trigger)
    await settle()

    expect(dialog().open).toBe(true)
    expect(dialog().querySelector('.kui-confirm-delete-message')?.textContent).toBe('Delete this?')

    click(dialog().querySelector('.kui-btn-danger'))
    await settle()

    expect([...dialog().querySelectorAll('button')].map(button => [button.textContent, button.disabled])).toEqual([['Cancel', true], ['Deleting…', true]])
    expect(dialog().getAttribute('closedby')).toBe('none')

    finish()
    await settle()

    expect(dialog().open).toBe(false)
  })

  test('toasts a failed delete and stays open for another try', async () => {
    const root = await dialogs(async () => Promise.reject(new Error('refused')))

    click(root.querySelector('.kui-icon-btn[aria-label="Delete"]'))
    await settle()
    click(root.querySelectorAll('dialog')[1]!.querySelector('.kui-btn-danger'))
    await settle()

    const dialog = root.querySelectorAll<HTMLDialogElement>('dialog')[1]!

    expect(dialog.open).toBe(true)
    expect([...dialog.querySelectorAll('button')].map(button => button.disabled)).toEqual([false, false])
    expect(root.querySelector('.kui-toast-message')?.textContent).toBe('Could not delete')
  })

  test('toasts what the handler refused with, through `refused`', async () => {
    const root = await dialogs()

    click(root.querySelector('.kui-icon-btn[aria-label="Archive"]'))
    await settle()
    click(root.querySelectorAll('dialog')[2]!.querySelector('.kui-btn-danger'))
    await settle()

    expect([...root.querySelectorAll('.kui-toast-message')].at(-1)?.textContent).toBe('Still referenced')
  })

  test('takes a labelled danger button as its trigger, for a delete known by another name', async () => {
    const root = await dialogs()
    const trigger = root.querySelector('.revoke')!

    expect([trigger.tagName, trigger.className, trigger.textContent]).toEqual(['BUTTON', 'kui-btn kui-btn-danger revoke', 'Revoke link'])

    click(trigger)
    await settle()

    expect(root.querySelectorAll<HTMLDialogElement>('dialog')[3]?.open).toBe(true)
  })
})
