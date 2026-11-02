import type { Mounted } from 'kay/test'
import { afterEach, expect, test } from 'bun:test'
import { mountComponent, settle } from 'kay/test'
import EditorExtra from '../tests/fixture/src/components/editor-extra.kay'

let mounted: Mounted | undefined

afterEach(() => {
  mounted?.unmount()
  Reflect.deleteProperty(document, 'execCommand')
})

async function editor(props: Record<string, unknown> = {}) {
  const state = { value: 'note' }

  mounted = await mountComponent(EditorExtra, { onInput: (next: string) => state.value = next, ...props })
  await settle()

  return { state, root: mounted.root, area: mounted.root.querySelector<HTMLTextAreaElement>('#editor')! }
}

const click = (root: Element, selector: string) => root.querySelector<HTMLElement>(selector)!.click()

test('an app button in the toolbarExtra block edits the field through the tools, and shows with toolbar false', async () => {
  const { state, root, area } = await editor()

  area.setSelectionRange(0, 4)
  click(root, '#callout')
  expect([state.value, area.value]).toEqual(['> [!NOTE]\n> note', '> [!NOTE]\n> note'])

  area.setSelectionRange(area.value.length, area.value.length)
  click(root, '#emoji')
  expect(state.value).toBe('> [!NOTE]\n> note:)')
  expect(root.querySelector('[role=toolbar] [data-part=extra]')).not.toBeNull()
})

test('a failed upload calls onImageError with the file and what was thrown, besides the toast, and removes its placeholder', async () => {
  const failures: [string, unknown][] = []
  const boom = new Error('too big')
  const { state, area } = await editor({ onImage: async () => {
    throw boom
  }, onImageError: (file: File, error: unknown) => failures.push([file.name, error]) })
  const file = new File(['x'], 'cat.png', { type: 'image/png' })

  area.dispatchEvent(Object.assign(new Event('paste', { bubbles: true, cancelable: true }), { clipboardData: { files: [file], types: [], getData: () => '' } }))
  await settle()
  await Bun.sleep(20)

  expect(failures).toEqual([['cat.png', boom]])
  expect(state.value).toBe('note')
  expect(document.body.textContent).toContain('Could not upload the image')
})

test('previewing follows the parent and onPreviewChange hears the toggle', async () => {
  const changes: boolean[] = []
  const { root } = await editor({ previewing: true, onPreviewChange: (next: boolean) => changes.push(next) })

  expect(root.querySelector('[data-part=grid]')?.hasAttribute('data-preview')).toBe(true)

  for (let tries = 0; tries < 200 && !root.querySelector('.kui-markdown-toggle'); tries++)
    await Bun.sleep(5)

  click(root, '.kui-markdown-toggle')
  await settle()
  expect(changes).toEqual([false])
})
