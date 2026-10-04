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

    expect(root.querySelector('.form-field-issue')?.textContent).toBe('Taken')
    expect(root.querySelector<HTMLDialogElement>('dialog')?.open).toBe(true)
    expect(root.querySelector('.toast')).toBeNull()

    answer = 'Ada'
    submit(root)
    await settle()

    expect(saved).toEqual(['Ada'])

    click(root.querySelector('#open'))
    await settle()

    expect(root.querySelector('.form-field')).not.toBeNull()
    expect(root.querySelector('.form-field-issue')).toBeNull()
  })

  test('toasts a call that failed outright and disables its buttons while one is under way', async () => {
    const { promise, reject } = Promise.withResolvers<string>()
    const root = await formDialog(async () => promise)

    submit(root)
    await settle()

    expect([...root.querySelectorAll<HTMLButtonElement>('.form-dialog-actions button')].map(button => [button.textContent, button.disabled])).toEqual([['Cancel', true], ['Saving…', true]])

    reject(new Error('offline'))
    await settle()

    expect(root.querySelector('.toast-message')?.textContent).toBe('Could not rename')
    expect(root.querySelector<HTMLDialogElement>('dialog')?.open).toBe(true)
  })
})
