import type { Mounted } from 'kay/test'
import { afterEach, describe, expect, test } from 'bun:test'
import { mount, settle } from 'kay/test'
import { click } from './dom'

let mounted: Mounted | undefined
const saved: string[] = []

afterEach(() => {
  mounted?.unmount()
  saved.length = 0
})

async function formDialog(save: (input: { name: string }) => Promise<string | { errors: Record<string, string> }>) {
  mounted = await mount('src/components/form-dialog.kay', { save, onSaved: (name: string) => saved.push(name) })

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
    let answer: string | { errors: Record<string, string> } = { errors: { name: 'Taken' } }
    const root = await formDialog(async () => answer)

    submit(root)
    await settle()

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
