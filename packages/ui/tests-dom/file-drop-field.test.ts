import type { Mounted } from 'kay/test'
import { afterEach, expect, test } from 'bun:test'
import { mountComponent, settle } from 'kay/test'
import FileDropField from '../tests/fixture/src/components/file-drop-field.kay'

let mounted: Mounted | undefined

afterEach(() => {
  mounted?.unmount()
})

test('a FormField names and describes the FileDrop zone, and leaves its hidden file input alone', async () => {
  mounted = await mountComponent(FileDropField, {})
  await settle()

  const { root } = mounted
  const zone = root.querySelector('#drop')!
  const text = root.querySelector('.kui-label-text')!
  const input = root.querySelector('input[type=file]')!

  expect(text.id).not.toBe('')
  expect(zone.getAttribute('aria-labelledby')).toBe(text.id)
  expect(zone.getAttribute('aria-describedby')).toBe(root.querySelector('[data-part=hint]')!.id)
  expect(['aria-labelledby', 'aria-describedby', 'aria-required', 'required'].filter(name => input.hasAttribute(name))).toEqual([])
})
