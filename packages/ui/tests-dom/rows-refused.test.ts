import type { Mounted } from 'kay/test'
import { afterEach, expect, test } from 'bun:test'
import { mountComponent, settle } from 'kay/test'
import FormRows from '../tests/fixture/src/components/form-rows.kay'
import { click } from './dom'

let mounted: Mounted | undefined

afterEach(() => mounted?.unmount())

async function refuse(errors: Record<string, string>) {
  mounted = await mountComponent(FormRows, { errors })
  click(mounted.root.querySelector('#submit'))
  await settle()

  return mounted.root
}

const rows = (root: Element) => [...root.querySelectorAll('#lines [data-part=row]')]
const invalid = (row: Element) => [...row.querySelectorAll('input')].map(input => input.getAttribute('aria-invalid'))
const issue = (row: Element) => row.querySelector<HTMLElement>('[data-part=issue]')!
const toasts = (root: Element) => root.querySelector('[data-part=toaster], .kui-toaster')?.textContent ?? ''

test('a refusal of one cell, by index, marks that cell and shows its message under its row, with no toast', async () => {
  const root = await refuse({ 'line_qty.1': 'Too many', 'line_name[0]': 'Name taken' })
  const [first, second] = rows(root)

  expect(invalid(first!)).toEqual(['true', null])
  expect(invalid(second!)).toEqual([null, 'true'])
  expect([issue(first!).textContent, issue(first!).hidden]).toEqual(['Name taken', false])
  expect([issue(second!).textContent, issue(second!).hidden]).toEqual(['Too many', false])
  expect(first!.querySelector('input')!.getAttribute('aria-describedby')).toBe(issue(first!).id)
  expect(root.textContent).not.toContain('Could not add')
  expect(toasts(root)).not.toContain('Too many')
})

test('a refusal of a row, or of a whole column as a schema gives it, shows under its row', async () => {
  const root = await refuse({ 'line.1': 'Row 2 is wrong', 'line_qty': 'Not a number' })
  const [first, second] = rows(root)

  expect([issue(first!).textContent, invalid(first!)]).toEqual(['Not a number', [null, 'true']])
  expect([issue(second!).textContent, invalid(second!)]).toEqual(['Row 2 is wrong', ['true', 'true']])
  expect(toasts(root)).not.toContain('Row 2 is wrong')
})

test('a refusal naming no row falls through to the toast, and size reaches the boxes', async () => {
  const root = await refuse({ 'line_name': 'Taken', 'line.9': 'Nowhere' })

  expect(rows(root).map(invalid)).toEqual([['true', null], ['true', null]])
  expect(root.textContent).toContain('Nowhere')
  expect(root.querySelector('#lines input')!.getAttribute('data-size')).toBe('sm')
})

test('a refusal of one item of a list shows under the FormField of the list', async () => {
  const root = await refuse({ 'tags.1': 'Not a tag' })

  expect(root.querySelector('[data-field=tags]')?.textContent).toBe('Not a tag')
})

test('a bare column refusal on a field with no rows has no row to show under, so it is toasted', async () => {
  mounted = await mountComponent(FormRows, { errors: { line_name: 'Taken' }, empty: true })
  click(mounted.root.querySelector('#submit'))
  await settle()

  expect(mounted.root.querySelectorAll('#lines [data-part=row]').length).toBe(0)
  expect(mounted.root.querySelector('#lines [data-field]')).toBeNull()
  expect(mounted.root.textContent).toContain('Taken')
})
