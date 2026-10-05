import type { Mounted } from 'kay/test'
import { afterEach, describe, expect, test } from 'bun:test'
import { mount, settle } from 'kay/test'

let mounted: Mounted | undefined

afterEach(() => {
  mounted?.unmount()
  Reflect.deleteProperty(document, 'execCommand')
})

// An editor whose every change is kept, read back through the returned getter.
async function editor(initial: string, onImage?: (file: File) => Promise<string>) {
  let value = initial

  mounted = await mount('src/components/editor.kay', { value: initial, onInput: (next: string) => value = next, onImage })

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
    clipboardData: { files, types: html ? ['text/html'] : [], getData: () => html ?? '' },
  })

  target.dispatchEvent(event)

  return event
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

  test('turns a pasted page into markdown', async () => {
    const state = await editor('')

    expect(paste(state.area, [], '<p>Read <strong>this</strong></p>').defaultPrevented).toBe(true)
    expect(state.value).toBe('Read **this**')
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

    expect(state.value).toBe('\n')
    expect([...state.root.querySelectorAll('.kui-toast-message')].at(-1)?.textContent).toBe('Could not upload the image')
  })

  test('lets a pasted image through untouched when nothing uploads it', async () => {
    const state = await editor('')

    expect(paste(state.area, [new File(['x'], 'cat.png', { type: 'image/png' })]).defaultPrevented).toBe(false)
  })
})
