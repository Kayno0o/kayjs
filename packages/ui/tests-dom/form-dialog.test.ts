import type { Mounted } from 'kay/test'
import { afterEach, describe, expect, test } from 'bun:test'
import { mountComponent, settle } from 'kay/test'
import { click } from './dom'

let mounted: Mounted | undefined
const saved: string[] = []

afterEach(() => {
  mounted?.unmount()
  saved.length = 0
})

type Answer = string | { errors: Record<string, string> } | { fail: { error: string, field?: string } }

async function formDialog(save: (input: { name: string }) => Promise<Answer>, plain = false) {
  mounted = await mountComponent('src/components/form-dialog.kay', { save, plain, onSaved: (name: string) => saved.push(name) })

  return mounted.root
}

function submit(root: HTMLElement) {
  root.querySelector('form')!.requestSubmit()
}

describe('FormDialog', () => {
  test('calls the action with the form\'s fields, hands back what it returned, and closes emptied', async () => {
    const calls: { name: string }[] = []
    const root = await formDialog(async (input) => {
      calls.push(input)

      return input.name.toUpperCase()
    })
    const input = root.querySelector<HTMLInputElement>('#name')!

    input.value = 'Grace'
    submit(root)
    await settle()

    expect(calls).toEqual([{ name: 'Grace' }])
    expect(saved).toEqual(['GRACE'])
    expect(root.querySelector<HTMLDialogElement>('dialog')?.open).toBe(false)

    click(root.querySelector('#open'))
    await settle()

    expect(root.querySelector<HTMLInputElement>('#name')?.value).toBe('Ada')
  })

  test('shows a refused field\'s message on its FormField and stays open, then drops it once saved', async () => {
    let answer: Answer = { errors: { name: 'Taken' } }
    const root = await formDialog(async () => answer)

    submit(root)
    await settle()

    const input = root.querySelector<HTMLInputElement>('#name')!
    const hint = root.querySelector('.kui-form-field-hint')!.id
    const issues = root.querySelector('.kui-form-field-issues')!.id

    expect(input.getAttribute('aria-invalid')).toBe('true')
    expect(input.getAttribute('aria-describedby')).toBe(`name-note ${hint} ${issues}`)
    expect(document.activeElement).toBe(input)

    expect(root.querySelector('.kui-form-field-issue')?.textContent).toBe('Taken')
    expect(root.querySelector<HTMLDialogElement>('dialog')?.open).toBe(true)
    expect(root.querySelector('.kui-toast')).toBeNull()

    answer = 'Ada'
    submit(root)
    await settle()

    expect(saved).toEqual(['Ada'])

    click(root.querySelector('#open'))
    await settle()

    expect(root.querySelector('.kui-form-field')).not.toBeNull()
    expect(root.querySelector('.kui-form-field-issue')).toBeNull()
    expect(root.querySelector('#name')?.getAttribute('aria-invalid')).toBeNull()
    expect(root.querySelector('#name')?.getAttribute('aria-describedby')).toBe(`name-note ${root.querySelector('.kui-form-field-hint')!.id}`)
  })

  test('marks every field of a group refused through its name, focusing the first, and clears them once refused for another field', async () => {
    let answer: Answer = { errors: { access: 'Pick one' } }
    const root = await formDialog(async () => answer)
    const marks = () => ['#login', '#admin'].map((id) => {
      const field = root.querySelector(id)!

      return [field.getAttribute('aria-invalid'), field.getAttribute('aria-describedby')]
    })

    submit(root)
    await settle()

    const issues = root.querySelector('fieldset > .kui-form-field-issues')!.id

    expect(marks()).toEqual([['true', issues], ['true', issues]])
    expect(root.querySelector('fieldset .kui-form-field-issue')?.textContent).toBe('Pick one')
    expect(document.activeElement).toBe(root.querySelector('#login'))
    expect(root.querySelector('.kui-toast')).toBeNull()

    answer = { errors: { name: 'Taken' } }
    submit(root)
    await settle()

    expect(marks()).toEqual([[null, null], [null, null]])
  })

  test('toasts a message no FormField shows, the whole form\'s included, and clears every message however it closed', async () => {
    const root = await formDialog(async () => ({ errors: { 'name': 'Taken', 'notes': 'Too long', '': 'Slow down' } }))

    submit(root)
    await settle()

    expect(root.querySelector('.kui-form-field-issue')?.textContent).toBe('Taken')
    expect([...root.querySelectorAll('.kui-toast-message')].map(toast => toast.textContent).slice(-2)).toEqual(['Too long', 'Slow down'])

    click(root.querySelector('#hide'))
    await settle()
    click(root.querySelector('#open'))
    await settle()

    expect(root.querySelector('.kui-form-field')).not.toBeNull()
    expect(root.querySelector('.kui-form-field-issue')).toBeNull()
  })

  test('shows what the handler refused with through refused: a field\'s message on its FormField, the whole form\'s toasted, an empty message leaving failure', async () => {
    let answer: Answer = { fail: { error: 'You already filed that slug', field: 'name' } }
    const root = await formDialog(async () => answer)
    // Toasts outlive a mounted dialog, so only new ones count.
    const toasts = () => root.querySelectorAll('.kui-toast-message').length
    const before = toasts()

    submit(root)
    await settle()

    expect(root.querySelector('.kui-form-field-issue')?.textContent).toBe('You already filed that slug')
    expect(toasts()).toBe(before)

    answer = { fail: { error: 'Too many short links' } }
    submit(root)
    await settle()

    expect(root.querySelector('.kui-form-field-issue')).toBeNull()
    expect([...root.querySelectorAll('.kui-toast-message')].at(-1)?.textContent).toBe('Too many short links')

    answer = { fail: { error: '' } }
    submit(root)
    await settle()

    expect([...root.querySelectorAll('.kui-toast-message')].at(-1)?.textContent).toBe('Could not rename')
    expect(root.querySelector<HTMLDialogElement>('dialog')?.open).toBe(true)
  })

  test('toasts failure for a handler\'s refusal when no refused reads it', async () => {
    const root = await formDialog(async () => ({ fail: { error: 'You already filed that slug', field: 'name' } }), true)

    submit(root)
    await settle()

    expect(root.querySelector('.kui-form-field-issue')).toBeNull()
    expect([...root.querySelectorAll('.kui-toast-message')].at(-1)?.textContent).toBe('Could not rename')
  })

  test('submits on Ctrl+Enter from a textarea, which keeps a plain Enter for new lines', async () => {
    let calls = 0
    const root = await formDialog(async () => {
      calls++

      return 'Ada'
    })
    const notes = root.querySelector('#notes')!

    notes.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    await settle()

    expect(calls).toBe(0)

    notes.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }))
    await settle()

    expect(calls).toBe(1)
  })

  test('toasts a call that failed outright and disables its buttons while one is under way', async () => {
    const { promise, reject } = Promise.withResolvers<string>()
    const root = await formDialog(async () => promise)

    submit(root)
    await settle()

    expect([...root.querySelectorAll<HTMLButtonElement>('.kui-form-dialog-actions button')].map(button => [button.textContent, button.disabled])).toEqual([['Cancel', true], ['Saving…', true]])

    reject(new Error('offline'))
    await settle()

    expect([...root.querySelectorAll('.kui-toast-message')].at(-1)?.textContent).toBe('Could not rename')
    expect(root.querySelector<HTMLDialogElement>('dialog')?.open).toBe(true)
  })
})

describe('FormDialog\'s onClose, deprecated for onOpenChange', () => {
  async function cancel(both: boolean) {
    const closes: string[] = []

    mounted = await mountComponent('src/components/form-dialog-old.kay', { closes, both })
    click(mounted.root.querySelector('.kui-form-dialog-actions button'))
    await settle()

    return closes
  }

  test('still hears the dialog close', async () => {
    expect(await cancel(false)).toEqual(['onClose'])
  })

  test('is ignored once onOpenChange is given', async () => {
    expect(await cancel(true)).toEqual(['onOpenChange false'])
  })
})
