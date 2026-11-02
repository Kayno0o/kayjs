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
