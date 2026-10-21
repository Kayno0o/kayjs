import type { Mounted } from 'kay/test'
import { afterEach, describe, expect, test } from 'bun:test'
import { mountComponent, settle } from 'kay/test'

let mounted: Mounted | undefined

afterEach(() => {
  mounted?.unmount()
  Reflect.deleteProperty(document, 'execCommand')
})

// An editor whose every change is kept, read back through the returned getter.
async function editor(initial: string, onImage?: (file: File) => Promise<string>, extra: Record<string, unknown> = {}) {
  let value = initial

  mounted = await mountComponent('src/components/editor.kay', { value: initial, onInput: (next: string) => value = next, onImage, ...extra })

  const area = mounted.root.querySelector<HTMLTextAreaElement>('#editor')!

  return { area, root: mounted.root, get value() {
    return value
  } }
}

function press(target: EventTarget, key: string, init: KeyboardEventInit = {}): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init })

  target.dispatchEvent(event)

  return event
}

function paste(target: EventTarget, files: File[], html?: string): Event {
  const event = Object.assign(new Event('paste', { bubbles: true, cancelable: true }), {
    clipboardData: { files, types: html === undefined ? [] : ['text/html'], getData: () => html ?? '' },
  })

  target.dispatchEvent(event)

  return event
}

// Resolves once a paste of rich text changed the reported value, the converter loading on the first one.
async function converted(state: { value: string }, previous: string): Promise<void> {
  for (let tries = 0; tries < 1000 && state.value === previous; tries++)
    await Bun.sleep(5)
}

describe('MarkdownEditor', () => {
  test('continues a list on Enter and reports the text', async () => {
    const state = await editor('- milk')

    state.area.setSelectionRange(6, 6)

    expect(press(state.area, 'Enter').defaultPrevented).toBe(true)
    expect(state.value).toBe('- milk\n- ')
    expect(state.area.selectionStart).toBe(9)
  })

  test('wraps the selection on Ctrl+B, and leaves Tab alone off a list, so the keyboard can still leave the field', async () => {
    const state = await editor('bold plain')

    state.area.setSelectionRange(0, 4)
    press(state.area, 'b', { ctrlKey: true })

    expect(state.value).toBe('**bold** plain')

    state.area.setSelectionRange(14, 14)

    expect(press(state.area, 'Tab').defaultPrevented).toBe(false)
  })

  test('indents a list item on Tab, and leaves the field on Escape then Tab, as it tells screen readers', async () => {
    const state = await editor('- milk')

    state.area.setSelectionRange(6, 6)

    expect(press(state.area, 'Tab').defaultPrevented).toBe(true)
    expect(state.value).toBe('  - milk')

    press(state.area, 'Escape')

    expect(press(state.area, 'Tab').defaultPrevented).toBe(false)
    expect(press(state.area, 'Tab').defaultPrevented).toBe(true)
    expect(state.area.getAttribute('aria-description')).toContain('Escape then Tab')
  })

  test('turns a pasted page into markdown', async () => {
    const state = await editor('')

    expect(paste(state.area, [], '<p>Read <strong>this</strong></p>').defaultPrevented).toBe(true)
    await converted(state, '')

    expect(state.value).toBe('Read **this**')
  })

  test('puts a paste at the caret of the moment it lands when the field changed while the converter loaded', async () => {
    const state = await editor('ab')

    state.area.setSelectionRange(1, 1)
    paste(state.area, [], '<strong>x</strong>')
    state.area.setRangeText(' typed ', 2, 2, 'end')
    await converted(state, 'ab')

    expect(state.value).toBe('ab typed **x**')
  })

  test('embeds a pasted image behind a placeholder, then swaps in the uploaded url', async () => {
    const uploads: (() => void)[] = []
    const state = await editor('Intro', async file => new Promise(resolve => uploads.push(() => resolve(`/images/${file.name}`))))

    state.area.setSelectionRange(5, 5)

    expect(paste(state.area, [new File(['x'], 'cat.png', { type: 'image/png' })]).defaultPrevented).toBe(true)

    await settle()

    expect(state.value).toBe('Intro![Uploading cat.png…]()\n')
    expect(state.area.getAttribute('aria-busy')).toBe('true')

    uploads[0]!()
    await settle()

    expect(state.value).toBe('Intro![](/images/cat.png)\n')
    expect(state.area.getAttribute('aria-busy')).toBe('false')
  })

  test('does not take focus back when an upload finishes after the user moved on', async () => {
    const uploads: (() => void)[] = []
    const state = await editor('', async file => new Promise(resolve => uploads.push(() => resolve(`/images/${file.name}`))))
    const title = state.root.querySelector<HTMLInputElement>('#title')!

    // happy-dom has no `execCommand`, and the editor only takes focus to go through it: one that refuses stands in for a browser's.
    Object.assign(document, { execCommand: () => false })
    state.area.focus()
    paste(state.area, [new File(['x'], 'cat.png', { type: 'image/png' })])
    title.focus()
    uploads[0]!()
    await settle()

    expect(state.value).toBe('![](/images/cat.png)\n')
    expect(document.activeElement).toBe(title)
  })

  test('removes the placeholder of an upload that failed, and toasts it', async () => {
    const state = await editor('', async () => Promise.reject(new Error('offline')))

    paste(state.area, [new File(['x'], 'cat.png', { type: 'image/png' })])
    await settle()

    expect(state.value).toBe('')
    expect([...state.root.querySelectorAll('.kui-toast-message')].at(-1)?.textContent).toBe('Could not upload the image')
  })

  test('lets a pasted image through untouched when nothing uploads it', async () => {
    const state = await editor('')

    expect(paste(state.area, [new File(['x'], 'cat.png', { type: 'image/png' })]).defaultPrevented).toBe(false)
  })
})

// Resolves once `ready` holds, polling, as the preview waits for a pause in typing.
async function until(ready: () => boolean): Promise<void> {
  for (let tries = 0; tries < 400 && !ready(); tries++)
    await Bun.sleep(5)
}

const buttons = (root: Element) => [...root.querySelectorAll<HTMLButtonElement>('.kui-markdown-bar button')]
const named = (root: Element, label: string) => buttons(root).find(button => button.getAttribute('aria-label') === label)!

describe('MarkdownEditor toolbar', () => {
  test('offers every format by default, and each acts on the selection', async () => {
    const state = await editor('word')

    expect(buttons(state.root).map(button => button.getAttribute('aria-label'))).toEqual(['Bold', 'Italic', 'Heading', 'Bulleted list', 'Numbered list', 'Link', 'Image'])

    state.area.setSelectionRange(0, 4)
    named(state.root, 'Bold').click()

    expect(state.value).toBe('**word**')

    named(state.root, 'Heading').click()

    expect(state.value).toBe('## **word**')

    named(state.root, 'Bulleted list').click()

    expect(state.value).toBe('- ## **word**')
  })

  test('can be turned off or cut down to a few buttons in the order given', async () => {
    const off = await editor('x', undefined, { toolbar: false })

    expect(off.root.querySelector('.kui-markdown-bar')).toBeNull()

    mounted?.unmount()

    const some = await editor('x', undefined, { toolbar: ['link', 'bold'] })

    expect(buttons(some.root).map(button => button.getAttribute('aria-label'))).toEqual(['Link', 'Bold'])
  })

  test('writes an image to fill in where nothing uploads', async () => {
    const state = await editor('')

    named(state.root, 'Image').click()

    expect(state.value).toBe('![](url)')
  })

  test('keeps the field named by its form field, not by the first button', async () => {
    const state = await editor('', undefined, { labelled: true })
    const label = state.root.querySelector('label')!

    const naming = state.root.querySelector(`#${state.area.getAttribute('aria-labelledby')}`)

    expect(label.control).toBe(state.area)
    expect(naming?.textContent).toBe('Body')
  })
})

describe('MarkdownEditor preview', () => {
  test('has no Preview button without a preview function', async () => {
    const state = await editor('x')

    expect(buttons(state.root).some(button => button.getAttribute('aria-label') === 'Preview')).toBe(false)
  })

  test('shows the server HTML once asked, follows the text, and hides on a second press', async () => {
    const asked: string[] = []
    const state = await editor('one', undefined, { preview: async (markdown: string) => {
      asked.push(markdown)

      return `<p>${markdown}</p>`
    } })
    const toggle = named(state.root, 'Preview')

    expect(state.root.querySelector('.kui-markdown-preview')).toBeNull()

    toggle.click()
    await until(() => state.root.querySelector('.kui-markdown-preview-body')?.innerHTML === '<p>one</p>')

    expect(toggle.getAttribute('aria-pressed')).toBe('true')
    expect(state.root.querySelector('.kui-markdown-preview-body')?.innerHTML).toBe('<p>one</p>')

    state.area.setRangeText(' two', 3, 3, 'end')
    state.area.dispatchEvent(new Event('input', { bubbles: true }))
    await until(() => state.root.querySelector('.kui-markdown-preview-body')?.innerHTML === '<p>one two</p>')

    expect(state.root.querySelector('.kui-markdown-preview-body')?.innerHTML).toBe('<p>one two</p>')

    toggle.click()
    await settle()

    expect(state.root.querySelector('.kui-markdown-preview')).toBeNull()
    expect(state.area.value).toBe('one two')
  })

  test('keeps the newest answer when an older call finishes last', async () => {
    const answers: ((html: string) => void)[] = []
    const state = await editor('a', undefined, { preview: async () => new Promise<string>(resolve => answers.push(resolve)) })

    named(state.root, 'Preview').click()
    await until(() => answers.length === 1)
    state.area.setRangeText('b', 1, 1, 'end')
    state.area.dispatchEvent(new Event('input', { bubbles: true }))
    await until(() => answers.length === 2)

    expect(answers).toHaveLength(2)

    answers[1]!('<p>newer</p>')
    await settle()
    answers[0]!('<p>older</p>')
    await settle()

    expect(state.root.querySelector('.kui-markdown-preview-body')?.innerHTML).toBe('<p>newer</p>')
  })

  test('says so in the pane when the call throws', async () => {
    const state = await editor('a', undefined, { preview: async () => {
      throw new Error('down')
    } })

    const log = console.error

    console.error = () => undefined
    named(state.root, 'Preview').click()
    await until(() => state.root.querySelector('.kui-markdown-preview-failed') !== null)
    console.error = log

    expect(state.root.querySelector('.kui-markdown-preview-failed')?.textContent).toBe('The preview could not be shown')
  })
})
