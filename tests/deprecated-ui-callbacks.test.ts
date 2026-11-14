import { describe, expect, it } from 'bun:test'
import { compileKay } from '../src/compiler'

const IMPORTS = [
  'import Tabs from \'@kayjs/ui/tabs.kay\'',
  'import Table from \'@kayjs/ui/table.kay\'',
  'import LineChart from \'@kayjs/ui/line-chart.kay\'',
  'import Other from \'./other.kay\'',
].join('\n')

// What the lint reports in a template, with the text of each fix applied to the source.
function found(template: string) {
  const source = `---\n${IMPORTS}\n---\n${template}\n`
  const diagnostics = compileKay(source, 'callbacks.kay', { check: true }).diagnostics.filter(d => d.code === 'deprecated-ui-callbacks')

  return diagnostics.map((d) => {
    const fix = d.fixes?.[0]
    const fixed = fix === undefined ? undefined : [...fix.edits].sort((a, b) => b.start - a.start).reduce((text, edit) => `${text.slice(0, edit.start)}${edit.text}${text.slice(edit.end)}`, source).split('---\n')[2]!.trim()

    return { at: source.slice(d.start, d.end), safe: fix?.safe, fixed }
  })
}

describe('deprecated-ui-callbacks', () => {
  it('renames the callback and destructures the event of an inline arrow function', () => {
    expect(found('Tabs(tabs={TABS} onChange={value => picked = value})')).toEqual([{ at: 'onChange', safe: true, fixed: 'Tabs(tabs={TABS} onValueChange={({ value }) => picked = value})' }])
    expect(found('Table(rows={ROWS} onSort={sort => saved = sort})')[0]?.fixed).toBe('Table(rows={ROWS} onSortChange={({ sort }) => saved = sort})')
  })

  it('keeps the name the arrow gave its parameter, and takes both of two', () => {
    expect(found('Tabs(tabs={TABS} onChange={(id, tab) => show(id, tab)})')[0]?.fixed).toBe('Tabs(tabs={TABS} onValueChange={({ value: id, tab }) => show(id, tab)})')
    expect(found('LineChart(onActive={index => hover = index})')[0]?.fixed).toBe('LineChart(onActiveChange={({ index }) => hover = index})')
  })

  it('renames any other value with an unsafe fix, as only the app knows what it takes', () => {
    expect(found('Tabs(tabs={TABS} onChange={picked.set})')).toEqual([{ at: 'onChange', safe: false, fixed: 'Tabs(tabs={TABS} onValueChange={picked.set})' }])
  })

  it('leaves the new names, other components and other props alone', () => {
    expect(found('Tabs(tabs={TABS} onValueChange={({ value }) => picked = value})')).toEqual([])
    expect(found('Other(onChange={value => picked = value})')).toEqual([])
    expect(found('Table(rows={ROWS} onLoad={({ rows }) => count = rows.length})')).toEqual([])
  })
})
