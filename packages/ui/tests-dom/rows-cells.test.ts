import type { Mounted } from 'kay/test'
import { afterEach, expect, test } from 'bun:test'
import { mountComponent, settle } from 'kay/test'
import RowsCells from '../tests/fixture/src/components/rows-cells.kay'
import { click } from './dom'

let mounted: Mounted | undefined

afterEach(() => mounted?.unmount())

async function quote() {
  const adds: string[] = []
  const removes: string[] = []

  mounted = await mountComponent(RowsCells, { adds, removes })
  await settle()

  return { root: mounted.root, adds, removes }
}

const posted = (root: Element) => [...new FormData(root.querySelector<HTMLFormElement>('#quote')!)].map(([name, value]) => `${name}=${String(value)}`)
const out = (root: Element) => JSON.parse(root.querySelector('#out')!.textContent) as Record<string, string>[]

function choose(select: HTMLSelectElement, value: string) {
  select.value = value
  select.dispatchEvent(new Event('change', { bubbles: true }))
}

test('a marked column is drawn by the cell block and a number column is a number box, posting under <name>_<key>', async () => {
  const { root } = await quote()
  const row = root.querySelector('#lines [data-part=row]')!

  expect([...row.querySelectorAll('input, select')].map(control => `${control.tagName}:${control.getAttribute('type')}:${control.getAttribute('name')}:${control.getAttribute('aria-label')}`)).toEqual(['INPUT:text:line_name:Item 1', 'INPUT:number:line_qty:Quantity 1', 'SELECT:null:line_unit:Unit 1'])
  expect(posted(root)).toEqual(['line_name=Cable', 'line_qty=2', 'line_unit=m'])
})

test('the cell writes into the row through set, the number box as text', async () => {
  const { root } = await quote()
  const row = root.querySelector('#lines [data-part=row]')!
  const qty = row.querySelector<HTMLInputElement>('input[type=number]')!

  choose(row.querySelector('select')!, 'kg')
  qty.value = '12.5'
  qty.dispatchEvent(new Event('input', { bubbles: true }))
  await settle()
  expect(out(root)).toEqual([{ name: 'Cable', qty: '12.5', unit: 'kg' }])
  expect(posted(root)).toEqual(['line_name=Cable', 'line_qty=12.5', 'line_unit=kg'])
})

test('adding focuses the first control of the new row, removing and adding are reported, and a reset brings the rows back', async () => {
  const { root, adds, removes } = await quote()

  click(root.querySelector('#lines [data-part=add]'))
  await settle()
  expect([adds, (document.activeElement as HTMLElement | null)?.getAttribute('name'), root.querySelectorAll('#lines [data-part=row]').length]).toEqual([['1:'], 'line_name', 2])
  expect(posted(root)).toEqual(['line_name=Cable', 'line_qty=2', 'line_unit=m', 'line_name=', 'line_qty=', 'line_unit=m'])

  click(root.querySelectorAll('#lines [data-part=remove]')[1]!)
  await settle()
  expect(removes).toEqual(['1:'])

  choose(root.querySelector('#lines select')!, 'kg')
  await settle()
  click(root.querySelector('#reset'))
  await settle()
  expect(out(root)).toEqual([{ name: 'Cable', qty: '2', unit: 'm' }])
  expect(posted(root)).toEqual(['line_name=Cable', 'line_qty=2', 'line_unit=m'])
})

test('a cell keeps its control while its row is edited', async () => {
  const { root } = await quote()
  const row = root.querySelector('#lines [data-part=row]')!
  const select = row.querySelector('select')!

  choose(select, 'kg')
  await settle()
  expect(root.querySelector('#lines select')).toBe(select)
  expect(select.value).toBe('kg')

  const qty = row.querySelector<HTMLInputElement>('input[type=number]')!

  qty.value = '5'
  qty.dispatchEvent(new Event('input', { bubbles: true }))
  await settle()
  expect(root.querySelector('#lines select')).toBe(select)
  expect(root.querySelector('#lines input[type=number]')).toBe(qty)
})

test('a row issue marks the boxes of that row only and shows its message under it, linked to them', async () => {
  const { root } = await quote()

  click(root.querySelector('#lines [data-part=add]'))
  await settle()

  const [first, second] = [...root.querySelectorAll('#lines [data-part=row]')]
  const qty = second!.querySelector<HTMLInputElement>('input[type=number]')!

  qty.value = '500'
  qty.dispatchEvent(new Event('input', { bubbles: true }))
  await settle()

  const marks = (row: Element) => [...row.querySelectorAll('input')].map(input => input.getAttribute('aria-invalid'))
  const message = second!.querySelector<HTMLElement>('[data-part=issue]')!

  expect(marks(first!)).toEqual([null, null])
  expect(marks(second!)).toEqual(['true', 'true'])
  expect(message.textContent).toBe('Too many')
  expect(message.hidden).toBe(false)
  expect(second!.querySelector('input')!.getAttribute('aria-describedby')).toBe(message.id)
  expect(first!.querySelector('input')!.hasAttribute('aria-describedby')).toBe(false)
  expect(first!.querySelector<HTMLElement>('[data-part=issue]')!.hidden).toBe(true)

  qty.value = '5'
  qty.dispatchEvent(new Event('input', { bubbles: true }))
  await settle()
  expect(marks(second!)).toEqual([null, null])
  expect(second!.querySelector('input')!.hasAttribute('aria-describedby')).toBe(false)
})

test('typing in a box keeps the element and its focus', async () => {
  const { root } = await quote()
  const name = root.querySelector<HTMLInputElement>('#lines input[name=line_name]')!

  name.focus()
  name.value = 'Cables'
  name.dispatchEvent(new Event('input', { bubbles: true }))
  await settle()
  expect(root.querySelector('#lines input[name=line_name]')).toBe(name)
  expect(document.activeElement).toBe(name)
})

test('removing a middle row leaves the controls of the others as they are, and a cell gets the row issue', async () => {
  const { root } = await quote()

  for (let at = 0; at < 2; at++) {
    click(root.querySelector('#lines [data-part=add]'))
    await settle()
  }

  const rows = [...root.querySelectorAll('#lines [data-part=row]')]
  const last = rows[2]!
  const select = last.querySelector('select')!
  const qty = last.querySelector<HTMLInputElement>('input[type=number]')!

  qty.value = '500'
  qty.dispatchEvent(new Event('input', { bubbles: true }))
  await settle()
  expect(select.getAttribute('aria-invalid')).toBe('true')
  expect(select.getAttribute('aria-describedby')).toBe(last.querySelector('[data-part=issue]')!.id)

  click(rows[1]!.querySelector('[data-part=remove]'))
  await settle()
  expect(root.querySelectorAll('#lines [data-part=row]')).toHaveLength(2)
  expect(root.querySelectorAll('#lines [data-part=row]')[1]).toBe(last)
  expect(last.querySelector('input[type=number]')).toBe(qty)
  expect(last.querySelector('select')!.getAttribute('aria-label')).toBe('Unit 2')
})

test('rowIssues given as a record by place marks that row only', async () => {
  const { root } = await quote()
  const [first, second] = [...root.querySelectorAll('#recorded [data-part=row]')]

  expect([...first!.querySelectorAll('input')].map(input => input.getAttribute('aria-invalid'))).toEqual([null, null, null])
  expect([...second!.querySelectorAll('input')].map(input => input.getAttribute('aria-invalid'))).toEqual(['true', 'true', 'true'])
  expect(second!.querySelector('[data-part=issue]')!.textContent).toBe('Bad B')
  expect(first!.querySelector('[data-part=issue]')!.hasAttribute('hidden')).toBe(true)
})

test('a reset brings the rows back, the cells keep working and the issues follow the rows', async () => {
  const { root } = await quote()

  click(root.querySelector('#lines [data-part=add]'))
  await settle()

  const added = root.querySelectorAll('#lines [data-part=row]')[1]!
  const qty = added.querySelector<HTMLInputElement>('input[type=number]')!

  qty.value = '500'
  qty.dispatchEvent(new Event('input', { bubbles: true }))
  await settle()
  expect(root.querySelectorAll('#lines [data-part=issue]:not([hidden])')).toHaveLength(1)

  click(root.querySelector('#reset'))
  await settle()
  expect(root.querySelectorAll('#lines [data-part=row]')).toHaveLength(1)
  expect(root.querySelectorAll('#lines [data-part=issue]:not([hidden])')).toHaveLength(0)

  choose(root.querySelector('#lines select')!, 'kg')
  await settle()
  expect(out(root)).toEqual([{ name: 'Cable', qty: '2', unit: 'kg' }])
})
