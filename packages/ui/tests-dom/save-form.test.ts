import type { Mounted } from 'kay/test'
import { afterEach, describe, expect, test } from 'bun:test'
import { mount, settle } from 'kay/test'
import { click } from './dom'

let mounted: Mounted | undefined
const saved: string[] = []
let discarded = 0

afterEach(() => {
  mounted?.unmount()
  saved.length = 0
  discarded = 0
})

type Answer = string | { errors: Record<string, string> }

async function saveForm(save: (input: { name: string }) => Promise<Answer>) {
  mounted = await mount('src/components/save-form.kay', { save, onSaved: (name: string) => saved.push(name), onDiscard: () => discarded++ })

  return mounted.root
}

function type(root: HTMLElement, value: string, selector = '#name', event = 'input') {
  const input = root.querySelector<HTMLInputElement>(selector)!

  input.value = value
  input.dispatchEvent(new Event(event, { bubbles: true }))
}

const status = (root: HTMLElement) => root.querySelector('.kui-save-bar-status')!.textContent
const buttons = (root: HTMLElement) => [...root.querySelectorAll<HTMLButtonElement>('.kui-save-bar-actions button')]

function leaves() {
  const event = new Event('beforeunload', { cancelable: true })

  window.dispatchEvent(event)

  return event.defaultPrevented
}

describe('SaveForm', () => {
  test('is clean at first, dirty once a field changes and clean again once it is typed back', async () => {
    const root = await saveForm(async name => name.name)
    const [discard, save] = buttons(root)

    expect(status(root)).toBe('No unsaved change.')
    expect(root.querySelector('.kui-save-bar-status')?.getAttribute('role')).toBe('status')
    expect(save!.getAttribute('aria-disabled')).toBe('true')

    type(root, 'Grace')
    await settle()

    expect(status(root)).toBe('Unsaved changes.')
    expect(save!.getAttribute('aria-disabled')).toBeNull()
    expect(discard!.getAttribute('aria-disabled')).toBeNull()

    type(root, 'Ada')
    await settle()

    expect(status(root)).toBe('No unsaved change.')
  })

  test('saves the fields, toasts, hands the result back and is clean again', async () => {
    const calls: string[] = []
    const root = await saveForm(async (input) => {
      calls.push(input.name)

      return input.name.toUpperCase()
    })

    type(root, 'Grace')
    await settle()
    root.querySelector('form')!.requestSubmit()
    await settle()

    expect(calls).toEqual(['Grace'])
    expect(saved).toEqual(['GRACE'])
    expect(status(root)).toBe('No unsaved change.')
    expect(root.querySelector('.kui-toast')?.textContent).toContain('Saved.')
    expect(leaves()).toBe(false)
  })

  test('a clean form calls nothing', async () => {
    let calls = 0
    const root = await saveForm(async () => {
      calls++

      return 'x'
    })

    root.querySelector('form')!.requestSubmit()
    await settle()

    expect(calls).toBe(0)
  })

  test('shows the saving text and busy button while the save is under way, and edits made meanwhile stay unsaved', async () => {
    let finish: (name: string) => void = () => undefined
    const root = await saveForm(async () => new Promise<string>((resolve) => {
      finish = resolve
    }))

    type(root, 'Grace')
    await settle()
    root.querySelector('form')!.requestSubmit()
    await settle()

    expect(status(root)).toBe('Saving…')
    expect(buttons(root)[1]!.getAttribute('aria-busy')).toBe('true')
    expect(leaves()).toBe(false)

    type(root, 'Graces')
    finish('Grace')
    await settle()

    expect(status(root)).toBe('Unsaved changes.')
    expect(leaves()).toBe(true)
  })

  test('a refused field keeps the bar dirty, shows its message and takes the focus', async () => {
    const root = await saveForm(async () => ({ errors: { name: 'Taken' } }))

    type(root, 'Grace')
    await settle()
    root.querySelector('form')!.requestSubmit()
    await settle()

    expect(root.querySelector('.kui-form-field-issue')?.textContent).toBe('Taken')
    expect(document.activeElement).toBe(root.querySelector('#name'))
    expect(status(root)).toBe('Unsaved changes.')
    expect(saved).toEqual([])
    expect(root.querySelector('.kui-toast')).toBeNull()
  })

  test('a failure no field shows is toasted and the bar stays dirty', async () => {
    const root = await saveForm(async () => {
      throw new Error('offline')
    })

    type(root, 'Grace')
    await settle()
    root.querySelector('form')!.requestSubmit()
    await settle()

    expect(root.querySelector('.kui-toast')?.textContent).toContain('Could not save')
    expect(status(root)).toBe('Unsaved changes.')
  })

  test('Discard restores the initial values, clears the messages and calls onDiscard', async () => {
    const answer: Answer = { errors: { name: 'Taken' } }
    const root = await saveForm(async () => answer)

    type(root, 'Grace')
    type(root, 'note', '#notes')
    await settle()
    root.querySelector('form')!.requestSubmit()
    await settle()

    click(buttons(root)[0]!)
    await settle()

    expect(root.querySelector<HTMLInputElement>('#name')!.value).toBe('Ada')
    expect(root.querySelector<HTMLTextAreaElement>('#notes')!.value).toBe('')
    expect(root.querySelector('.kui-form-field-issue')).toBeNull()
    expect(status(root)).toBe('No unsaved change.')
    expect(discarded).toBe(1)
  })

  test('Discard after a save goes back to the saved values', async () => {
    const root = await saveForm(async input => input.name)

    type(root, 'Grace')
    await settle()
    root.querySelector('form')!.requestSubmit()
    await settle()
    type(root, 'Hopper')
    await settle()

    expect(status(root)).toBe('Unsaved changes.')

    click(buttons(root)[0]!)
    await settle()

    expect(root.querySelector<HTMLInputElement>('#name')!.value).toBe('Grace')
    expect(status(root)).toBe('No unsaved change.')
  })

  test('a failure no field shows keeps the focus on the Save button', async () => {
    const root = await saveForm(async () => {
      throw new Error('offline')
    })

    type(root, 'Grace')
    await settle()
    buttons(root)[1]!.focus()
    root.querySelector('form')!.requestSubmit()
    await settle()

    expect(document.activeElement).toBe(buttons(root)[1]!)
  })

  test('a control added to the form makes it dirty', async () => {
    const root = await saveForm(async () => 'x')

    click(root.querySelector('#more'))
    await settle()
    type(root, 'value', '#extra')
    await settle()

    expect(status(root)).toBe('Unsaved changes.')
  })

  test('leaving asks while dirty and not when clean', async () => {
    const root = await saveForm(async () => 'x')

    expect(leaves()).toBe(false)

    type(root, 'Grace')
    await settle()

    expect(leaves()).toBe(true)

    click(buttons(root)[0]!)
    await settle()

    expect(leaves()).toBe(false)
  })

  test('Ctrl+S and Cmd+S save, and the browser\'s own save is kept away', async () => {
    const root = await saveForm(async input => input.name)

    type(root, 'Grace')
    await settle()

    const event = new KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true, cancelable: true })

    root.querySelector('#name')!.dispatchEvent(event)
    await settle()

    expect(event.defaultPrevented).toBe(true)
    expect(saved).toEqual(['Grace'])

    type(root, 'Hopper')
    await settle()
    root.querySelector('#name')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'S', metaKey: true, bubbles: true, cancelable: true }))
    await settle()

    expect(saved).toEqual(['Grace', 'Hopper'])
  })

  test('Discard puts the library\'s signal-driven controls back on the saved values, and the page signals with them', async () => {
    mounted = await mount('src/components/save-form-controls.kay', {})
    await settle()

    const root = mounted.root
    const state = () => JSON.parse(root.querySelector('#state')!.textContent!) as Record<string, unknown>
    const edit = async (deck: string, level: string, title: string) => {
      click(root.querySelector('input[name="agree"]'))
      click(root.querySelector('input[name="power"]'))
      click(root.querySelector(`input[name="decks"][value="${deck}"]`))
      type(root, level, '#level', 'change')
      click(root.querySelectorAll('.kui-multi-select-checkbox')[1] ?? null)
      type(root, title, '#title')
      await settle()
    }

    await edit('films', 'b', 'Grace')
    expect(state()).toEqual({ agree: true, power: true, decks: ['films'], level: 'b', tags: ['x', 'y'], title: 'Grace' })

    root.querySelector('form')!.requestSubmit()
    await settle()
    expect(status(root)).toBe('No unsaved change.')

    await edit('games', 'a', 'Hopper')
    expect(status(root)).toBe('Unsaved changes.')

    click(buttons(root)[0]!)
    // The controls follow a task after the reset, and the bar reads them a task after that.
    await settle()
    await settle()

    expect(state()).toEqual({ agree: true, power: true, decks: ['films'], level: 'b', tags: ['x', 'y'], title: 'Grace' })
    expect(status(root)).toBe('No unsaved change.')
  })
})
