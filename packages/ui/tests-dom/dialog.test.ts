import type { Mounted } from 'kay/test'
import { afterEach, describe, expect, jest, test } from 'bun:test'
import { mountComponent, settle } from 'kay/test'
import { click } from './dom'

let mounted: Mounted | undefined
let closes = 0

afterEach(() => {
  mounted?.unmount()
  closes = 0
})

async function dialogs(onDelete: () => Promise<void> = async () => Promise.resolve(), dirty = false, apiRefusal?: { status: number, message: string, answer?: unknown }) {
  mounted = await mountComponent('src/components/dialogs.kay', { onClose: () => closes++, onDelete, dirty, apiRefusal })

  return mounted.root
}

describe('Dialog', () => {
  test('opens as a modal holding its title as an h2 and its content, which it drops once closed', async () => {
    const root = await dialogs()
    const dialog = root.querySelector<HTMLDialogElement>('#dialog')!

    expect(dialog.open).toBe(false)
    expect(dialog.querySelector('#name')).toBeNull()

    click(root.querySelector('#open'))
    await settle()

    expect(dialog.open).toBe(true)
    expect(dialog.querySelector('h2.kui-dialog-title')?.textContent).toBe('Rename')
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

  test('lets Escape close a dialog with no footer once something was typed, a click outside still held', async () => {
    const root = await dialogs()
    const dialog = root.querySelector<HTMLDialogElement>('#bare')!

    click(root.querySelector('#open-bare'))
    await settle()
    dialog.querySelector('#bare-name')!.dispatchEvent(new Event('input', { bubbles: true }))
    await settle()

    expect(dialog.getAttribute('closedby')).toBe('closerequest')
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

  test('toasts what the handler refused with, through `refused`', async () => {
    const root = await dialogs()

    click(root.querySelector('.kui-icon-btn[aria-label="Archive"]'))
    await settle()
    click(root.querySelectorAll('dialog')[2]!.querySelector('.kui-btn-danger'))
    await settle()

    expect([[...root.querySelectorAll('.kui-toast-message')].at(-1)?.textContent, root.querySelectorAll('dialog')[2]!.open]).toEqual(['Still referenced', true])
  })

  // A delete made with `call()` throws ApiError, which refuses as an action does: the dialog stays open and enabled with the route's message toasted.
  test.each([
    { name: 'a refusal with words of its own', refusal: { status: 409, message: 'Still referenced', answer: 'Still referenced' }, trigger: 'Delete', dialog: 1, toast: 'Still referenced' },
    { name: 'a refusal `refused` reads the answer of', refusal: { status: 409, message: 'Conflict', answer: { reason: 'In use' } }, trigger: 'Release', dialog: 14, toast: 'IN USE' },
    { name: 'a network failure', refusal: { status: 0, message: 'Failed to fetch' }, trigger: 'Delete', dialog: 1, toast: 'Could not delete' },
    { name: 'a server fault', refusal: { status: 500, message: 'Boom', answer: 'Boom' }, trigger: 'Delete', dialog: 1, toast: 'Could not delete' },
  ])('toasts $name from an ApiError and keeps the dialog open', async ({ refusal, trigger, dialog, toast }) => {
    const root = await dialogs(undefined, false, refusal)

    click(root.querySelector(`.kui-icon-btn[aria-label="${trigger}"]`))
    await settle()

    const shown = root.querySelectorAll('dialog')[dialog]!

    click(shown.querySelector('.kui-btn-danger'))
    await settle()

    expect([root.querySelector('.kui-toast-message')?.textContent, shown.open, shown.querySelector('.kui-btn-danger')?.hasAttribute('disabled')]).toEqual([toast, true, false])
  })

  test('toasts failure and re-enables the buttons when `refused` throws on an answer it did not expect', async () => {
    const spy = jest.spyOn(console, 'error').mockImplementation(() => undefined)
    const root = await dialogs(undefined, false, { status: 409, message: 'Conflict', answer: {} })

    click(root.querySelector('.kui-icon-btn[aria-label="Release"]'))
    await settle()

    const shown = root.querySelectorAll('dialog')[14]!

    click(shown.querySelector('.kui-btn-danger'))
    await settle()

    expect([root.querySelector('.kui-toast-message')?.textContent, shown.open, shown.querySelector('.kui-btn-danger')?.hasAttribute('disabled')]).toEqual(['Could not release', true, false])
    expect(spy).toHaveBeenCalledTimes(1)
    spy.mockRestore()
  })

  test('hands its tone to the icon trigger once a variant is given, and leaves the default look without one', async () => {
    const root = await dialogs()
    const look = (name: string) => {
      const trigger = root.querySelector<HTMLElement>(`.kui-icon-btn.${name}`)!

      return [trigger.dataset.variant, trigger.dataset.tone]
    }

    expect(look('v-plain')).toEqual(['solid', 'neutral'])
    expect(look('v-solid')).toEqual(['solid', 'danger'])
    expect(look('v-ghost')).toEqual(['ghost', 'danger'])
    expect(look('v-inline')).toEqual(['inline', 'danger'])
    expect(look('n-plain')).toEqual(['solid', 'neutral'])
    expect(look('n-solid')).toEqual(['solid', 'neutral'])
    expect(look('n-ghost')).toEqual(['ghost', 'neutral'])
    expect(root.querySelector('.n-button')?.className).toBe('kui-btn kui-btn-danger n-button')
  })

  // A trigger of each kind, the dialog it opens (by its place among the page's) and the confirm button it carries.
  const TRIGGERS = [
    { name: 'a labelled danger button, for a delete known by another name', trigger: '.revoke', dialog: 3, shown: ['BUTTON', 'kui-btn kui-btn-danger revoke', 'Revoke link'], title: 'Confirm Deletion', confirm: ['kui-btn kui-btn-danger', 'Delete'] },
    { name: 'a plain text link, its dialog a title and confirm labels of its own', trigger: '.rotate', dialog: 4, shown: ['BUTTON', 'kui-confirm-delete-link rotate', 'Rotate link'], title: 'Rotate link', confirm: ['kui-btn kui-btn-danger', 'Rotate'] },
    { name: 'a confirm that is not a deletion, which reads neutrally and toasts its success once', trigger: '.save', dialog: 5, shown: ['BUTTON', 'kui-btn kui-btn-accent save', 'Save'], title: 'Save', confirm: ['kui-btn kui-btn-accent', 'Save'], toast: 'Saved' },
  ]

  test.each(TRIGGERS)('takes $name as its trigger', async ({ trigger, dialog: place, shown, title, confirm, toast }) => {
    const root = await dialogs()
    const opener = root.querySelector(trigger)!

    expect([opener.tagName, opener.className, opener.textContent]).toEqual(shown)

    click(opener)
    await settle()

    const dialog = root.querySelectorAll<HTMLDialogElement>('dialog')[place]!
    const button = dialog.querySelector<HTMLButtonElement>('.kui-dialog-footer button:last-child')!

    expect([dialog.open, dialog.querySelector('.kui-dialog-title')?.textContent, button.className, button.textContent]).toEqual([true, title, ...confirm])

    click(button)
    await settle()

    expect([dialog.open, root.querySelector('.kui-toast-message')?.textContent]).toEqual([false, toast])
  })

  test('asks inline when told to: armed by a click, it deletes or cancels in place, and hands the focus back', async () => {
    const { promise, resolve: finish } = Promise.withResolvers<void>()
    const root = await dialogs(async () => promise)
    const trigger = root.querySelector<HTMLButtonElement>('.kui-icon-btn[aria-label="Remove"]')!
    const armed = () => root.querySelector('.kui-confirm-delete-armed')
    const buttons = () => [...armed()?.querySelectorAll('button') ?? []].map(button => [button.textContent || button.getAttribute('aria-label'), button.disabled])

    expect(root.querySelectorAll('dialog')).toHaveLength(17)

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

  // A delete the handler rejects toasts, and leaves the confirmation open and enabled for another try, asked in a dialog or inline.
  test.each([
    { how: 'in a dialog', focused: undefined, trigger: '.kui-icon-btn[aria-label="Delete"]', confirmation: (root: Element) => root.querySelectorAll('dialog')[1]!, toast: 'Could not delete' },
    { how: 'inline', trigger: '.kui-icon-btn[aria-label="Remove"]', confirmation: (root: Element) => root.querySelector('.kui-confirm-delete-armed')!, toast: 'Could not remove', focused: 'Delete' },
  ])('asked $how, toasts a failed delete and stays open for another try', async ({ trigger, confirmation, toast, focused }) => {
    const root = await dialogs(async () => Promise.reject(new Error('refused')))

    click(root.querySelector(trigger))
    await settle()
    click(confirmation(root).querySelector('.kui-btn-danger'))
    await settle()

    expect([confirmation(root).querySelector('.kui-btn-danger')?.hasAttribute('disabled'), root.querySelector('.kui-toast-message')?.textContent, confirmation(root).closest('dialog')?.open ?? true]).toEqual([false, toast, true])

    if (focused !== undefined)
      expect(document.activeElement?.textContent).toBe(focused)
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

  test('disabled disables its trigger, and keeps an open dialog open with its confirm button disabled until it is false again', async () => {
    const onDelete = jest.fn(async () => Promise.resolve())
    const root = await dialogs(onDelete)
    const held = root.querySelector<HTMLButtonElement>('.held')!

    click(held)
    await settle()

    const dialog = [...root.querySelectorAll<HTMLDialogElement>('dialog')].at(-1)!
    const confirm = () => [...dialog.querySelectorAll<HTMLButtonElement>('button')].find(each => each.textContent?.trim() === 'Delete')!

    expect(dialog.open).toBe(true)
    click(root.querySelector('#busy'))
    await settle()
    expect(dialog.open).toBe(true)
    expect(held.disabled).toBe(true)
    expect(confirm().disabled).toBe(true)
    click(confirm())
    await settle()
    expect(onDelete).not.toHaveBeenCalled()

    click(root.querySelector('#busy'))
    await settle()
    expect(confirm().disabled).toBe(false)
  })
})
