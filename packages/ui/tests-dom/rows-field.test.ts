import type { Mounted } from 'kay/test'
import { afterEach, describe, expect, test } from 'bun:test'
import { mountComponent, settle } from 'kay/test'
import RowsFields from '../tests/fixture/src/components/rows-fields.kay'
import { untilHolds } from '../tests/until'
import { click } from './dom'

let mounted: Mounted | undefined
const posted: [string, string][][] = []

afterEach(() => {
  mounted?.unmount()
  posted.length = 0
})

async function open() {
  mounted = await mountComponent(RowsFields, { save: async (form: FormData) => {
    posted.push([...form].map(([name, value]) => [name, String(value)]))
  } })

  return mounted.root
}

const rowsOf = (root: Element, id: string) => [...root.querySelectorAll(`#${id} [data-part=row]`)]
const out = (root: Element) => JSON.parse(root.querySelector('#out')!.textContent) as { name: string, value: string }[]
const inputs = (row: Element) => [...row.querySelectorAll('input')]

function type(input: HTMLInputElement, value: string) {
  input.value = value
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

describe('RowsField in a signal editor', () => {
  test('draws a labelled box per column and row, the headings once, and a labelled remove button', async () => {
    const root = await open()
    const [first] = rowsOf(root, 'editor')

    expect(rowsOf(root, 'editor')).toHaveLength(2)
    expect(root.querySelector('#editor')?.getAttribute('aria-label')).toBe('Response headers')
    expect([...root.querySelectorAll('#editor [data-part=heading]')].map(heading => heading.textContent)).toEqual(['Header', 'Value'])
    expect(inputs(first!).map(input => [input.getAttribute('aria-label'), input.placeholder, input.value])).toEqual([['Header 1', 'Header', 'X-Frame-Options'], ['Value 1', 'Value of the header', 'DENY']])
    expect(first!.querySelector('button')?.getAttribute('aria-label')).toBe('Remove header 1')
  })

  test('hands the rows to onChange on every edit', async () => {
    const root = await open()

    type(inputs(rowsOf(root, 'editor')[1]!)[1]!, 'max-age=0')
    await settle()

    expect(out(root)).toEqual([{ name: 'X-Frame-Options', value: 'DENY' }, { name: 'Cache-Control', value: 'max-age=0' }])
  })

  test('adds a blank row, focuses its first box and stops at max', async () => {
    const root = await open()
    const add = root.querySelector<HTMLButtonElement>('#editor [data-part=add]')!

    click(add)
    await settle()

    expect(out(root)).toHaveLength(3)
    expect(out(root)[2]).toEqual({ name: '', value: '' })
    expect(document.activeElement).toBe(inputs(rowsOf(root, 'editor')[2]!)[0]!)
    expect(add.disabled).toBe(true)
  })

  test('removes a row without disturbing the boxes of the others, and stops at min', async () => {
    const root = await open()
    const [first, second] = rowsOf(root, 'editor')
    const kept = inputs(second!)[0]!

    click(first!.querySelector('button'))
    await settle()

    expect(out(root)).toEqual([{ name: 'Cache-Control', value: 'no-store' }])
    expect(rowsOf(root, 'editor')[0]).toBe(second)
    expect(inputs(rowsOf(root, 'editor')[0]!)[0]).toBe(kept)
    expect(kept.getAttribute('aria-label')).toBe('Header 1')
    expect(rowsOf(root, 'editor')[0]!.querySelector('button')!.getAttribute('aria-disabled')).toBe('true')
    expect(document.activeElement).toBe(kept)
  })
})

describe('RowsField in a form', () => {
  test('posts each column under its own name, once per row and in order', async () => {
    const root = await open()
    const form = root.querySelector<HTMLFormElement>('#plain')!

    click(root.querySelector('#posted [data-part=add]'))
    await settle()
    type(inputs(rowsOf(root, 'posted')[1]!)[0]!, 'B')

    expect([...new FormData(form)]).toEqual([['header_name', 'A'], ['header_value', '1'], ['header_name', 'B'], ['header_value', '']])
  })

  test('a reset brings back the rows it started with', async () => {
    const root = await open()
    const form = root.querySelector<HTMLFormElement>('#plain')!

    click(root.querySelector('#posted [data-part=add]'))
    click(rowsOf(root, 'posted')[0]!.querySelector('button'))
    await settle()
    expect(rowsOf(root, 'posted')).toHaveLength(1)
    expect(inputs(rowsOf(root, 'posted')[0]!)[0]!.value).toBe('')

    form.reset()
    await settle()
    await settle()

    expect(rowsOf(root, 'posted')).toHaveLength(1)
    expect(inputs(rowsOf(root, 'posted')[0]!)[0]!.value).toBe('A')
  })

  test('a SaveForm sees an added row as a change and posts it', async () => {
    const root = await open()
    const form = root.querySelector<HTMLFormElement>('form[data-part=root]')!
    const status = root.querySelector('.kui-save-bar-status')!

    expect(status.textContent).toBe('No unsaved change.')
    click(root.querySelector('#saved [data-part=add]'))
    await settle()
    expect(status.textContent).toBe('Unsaved changes.')

    form.requestSubmit()
    await settle()

    expect(posted).toEqual([[['saved_name', 'A'], ['saved_value', '1'], ['saved_name', ''], ['saved_value', '']]])
    expect(status.textContent).toBe('No unsaved change.')
  })

  test('Discard after a save goes back to the rows saved, not the ones first drawn', async () => {
    const root = await open()
    const discard = root.querySelector<HTMLButtonElement>('.kui-save-bar-actions button')!

    click(root.querySelector('#saved [data-part=add]'))
    await settle()
    type(inputs(rowsOf(root, 'saved')[1]!)[0]!, 'B')
    await settle()
    root.querySelector<HTMLFormElement>('form[data-part=root]')!.requestSubmit()
    await settle()

    click(rowsOf(root, 'saved')[0]!.querySelector('button'))
    click(root.querySelector('#saved [data-part=add]'))
    await settle()
    expect(rowsOf(root, 'saved').map(row => inputs(row)[0]!.value)).toEqual(['B', ''])

    click(discard)
    await settle()
    await settle()

    expect([rowsOf(root, 'saved').map(row => inputs(row).map(input => input.value)), root.querySelector('.kui-save-bar-status')!.textContent]).toEqual([[['A', '1'], ['B', '']], 'No unsaved change.'])
  })
})

describe('RowsField words', () => {
  // What the page's shared live region says now, whose first words wait for it to have been there.
  const said = () => document.querySelector('[data-kui-announce]')?.textContent.trim() ?? ''

  test('names a remove button Remove row n when no removeLabel is given', async () => {
    const root = await open()

    expect(rowsOf(root, 'posted')[0]!.querySelector('button')?.getAttribute('aria-label')).toBe('Remove row 1')
  })

  test('says a row was added, and which one was removed', async () => {
    const root = await open()

    click(root.querySelector('#posted [data-part=add]'))
    await untilHolds(() => said() === 'Row 2 added')
    expect(said()).toBe('Row 2 added')

    click(rowsOf(root, 'posted')[0]!.querySelector('button'))
    await settle()
    expect(said()).toBe('Row 1 removed')
  })
})
