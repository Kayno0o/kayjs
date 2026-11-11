import type { Mounted } from 'kay/test'
import { afterEach, expect, test } from 'bun:test'
import { mountComponent, settle } from 'kay/test'
import RefusedGroups from '../tests/fixture/src/components/refused-groups.kay'
import { click } from './dom'

let mounted: Mounted | undefined

afterEach(() => {
  mounted?.unmount()
})

const GROUPS = ['chip-group', 'file-drop', 'range-input']

test('a group showing a message is marked data-invalid and carries no aria-invalid, its message describing it', async () => {
  mounted = await mountComponent(RefusedGroups, {})
  await settle()

  const { root } = mounted

  for (const id of GROUPS) {
    const group = root.querySelector(`#${id}`)!
    const issues = group.closest('[data-kui-field]')!.querySelector('[data-part=issues][id]')!

    expect([id, group.getAttribute('role'), group.hasAttribute('data-invalid'), group.hasAttribute('aria-invalid')]).toEqual([id, 'group', true, false])
    expect([id, (group.getAttribute('aria-describedby') ?? '').split(' ').includes(issues.id)]).toEqual([id, true])
  }
})

test('a RowsField told it is invalid is marked data-invalid on its group, not aria-invalid', async () => {
  mounted = await mountComponent(RefusedGroups, {})
  await settle()

  const group = mounted.root.querySelector('#rows-field')!

  expect([group.getAttribute('role'), group.hasAttribute('data-invalid'), group.hasAttribute('aria-invalid')]).toEqual(['group', true, false])
})

test('focusInvalid reaches a data-invalid group', async () => {
  mounted = await mountComponent(RefusedGroups, {})
  await settle()

  click(mounted.root.querySelector('#focus'))
  await settle()

  const active = document.activeElement

  expect(active).not.toBe(document.body)
  expect(mounted.root.querySelector('#chip-group')!.contains(active)).toBe(true)
})
