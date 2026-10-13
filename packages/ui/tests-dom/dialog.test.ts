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

    expect([[...root.querySelectorAll('.kui-toast-message')].at(-1)?.textContent, root.querySelectorAll('dialog')[2]!.open]).toEqual(['Still referenced', true])
  })

  test('takes a labelled danger button as its trigger, for a delete known by another name', async () => {
    const root = await dialogs()
    const trigger = root.querySelector('.revoke')!

    expect([trigger.tagName, trigger.className, trigger.textContent]).toEqual(['BUTTON', 'kui-btn kui-btn-danger revoke', 'Revoke link'])

    click(trigger)
    await settle()

    expect(root.querySelectorAll<HTMLDialogElement>('dialog')[3]?.open).toBe(true)
  })

  test('takes a plain text link as its trigger, and its dialog a title and confirm labels of its own', async () => {
    const root = await dialogs()
    const trigger = root.querySelector('.rotate')!

    expect([trigger.tagName, trigger.className, trigger.textContent]).toEqual(['BUTTON', 'kui-confirm-delete-link rotate', 'Rotate link'])

    click(trigger)
    await settle()

    const dialog = root.querySelectorAll<HTMLDialogElement>('dialog')[4]!

    expect([dialog.open, dialog.querySelector('.kui-dialog-title')?.textContent, dialog.querySelector('.kui-btn-danger')?.textContent]).toEqual([true, 'Rotate link', 'Rotate'])
  })

  test('asks inline when told to: armed by a click, it deletes or cancels in place, and hands the focus back', async () => {
    const { promise, resolve: finish } = Promise.withResolvers<void>()
    const root = await dialogs(async () => promise)
    const trigger = root.querySelector<HTMLButtonElement>('.kui-icon-btn[aria-label="Remove"]')!
    const armed = () => root.querySelector('.kui-confirm-delete-armed')
    const buttons = () => [...armed()?.querySelectorAll('button') ?? []].map(button => [button.textContent || button.getAttribute('aria-label'), button.disabled])

    expect(root.querySelectorAll('dialog')).toHaveLength(5)

    click(trigger)
    await settle()

    expect([trigger.hidden, armed()?.getAttribute('aria-label'), buttons(), document.activeElement?.textContent]).toEqual([true, 'Its verdicts go with it.', [['Delete', false], ['Cancel', false]], 'Delete'])
    expect(armed()?.querySelector('.kui-btn-danger')?.getAttribute('data-tooltip')).toBe('Its verdicts go with it.')

    armed()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await settle()

    expect([trigger.hidden, armed(), document.activeElement]).toEqual([false, null, trigger])

    click(trigger)
    await settle()
    click(armed()!.querySelector('.kui-btn-danger'))
    await settle()

    expect(buttons()).toEqual([['Deleting…', true], ['Cancel', true]])

    finish()
    await settle()

    expect([trigger.hidden, armed()]).toEqual([false, null])
  })

  test('asked inline, toasts a failed delete and stays armed for another try', async () => {
    const root = await dialogs(async () => Promise.reject(new Error('refused')))

    click(root.querySelector('.kui-icon-btn[aria-label="Remove"]'))
    await settle()
    click(root.querySelector('.kui-confirm-delete-armed .kui-btn-danger'))
    await settle()

    expect([root.querySelector('.kui-confirm-delete-armed .kui-btn-danger')?.hasAttribute('disabled'), root.querySelector('.kui-toast-message')?.textContent, document.activeElement?.textContent]).toEqual([false, 'Could not remove', 'Delete'])
  })

  test('asked inline, hides a labelled button or a text link as it hides the icon', async () => {
    const root = await dialogs()

    for (const name of ['unshare', 'forget']) {
      const trigger = root.querySelector<HTMLButtonElement>(`.${name}`)!

      click(trigger)
      await settle()

      expect([name, trigger.hidden, root.querySelectorAll('.kui-confirm-delete-armed').length]).toEqual([name, true, 1])

      click(root.querySelector('.kui-confirm-delete-armed .kui-icon-btn'))
      await settle()

      expect([name, trigger.hidden, document.activeElement]).toEqual([name, false, trigger])
    }
  })
})
