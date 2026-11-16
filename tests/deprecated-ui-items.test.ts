import { describe, expect, it } from 'bun:test'
import { compileKay } from '../src/compiler'

const IMPORTS = [
  'import Tabs from \'@kayjs/ui/tabs.kay\'',
  'import SideNav from \'@kayjs/ui/side-nav.kay\'',
  'import AppHeader from \'@kayjs/ui/app-header.kay\'',
  'import Timeline from \'@kayjs/ui/timeline.kay\'',
  'import TabNav from \'@kayjs/ui/tab-nav.kay\'',
  'import Other from \'./other.kay\'',
].join('\n')

// What the lint reports in a template, with the text of each fix applied to the source.
function found(template: string) {
  const source = `---\n${IMPORTS}\n---\n${template}\n`
  const diagnostics = compileKay(source, 'items.kay', { check: true }).diagnostics.filter(d => d.code === 'deprecated-ui-items')

  return diagnostics.map((d) => {
    const fix = d.fixes?.[0]
    const fixed = fix === undefined ? undefined : [...fix.edits].sort((a, b) => b.start - a.start).reduce((text, edit) => `${text.slice(0, edit.start)}${edit.text}${text.slice(edit.end)}`, source).split('---\n')[2]!.trim()

    return { at: source.slice(d.start, d.end), safe: fix?.safe, fixed }
  })
}

describe('deprecated-ui-items', () => {
  it('writes items for the list each component named its own way', () => {
    expect(found('Tabs(tabs={TABS} label="x" value="a")')).toEqual([{ at: 'tabs', safe: true, fixed: 'Tabs(items={TABS} label="x" value="a")' }])
    expect(found('SideNav(links={LINKS} current="/")')[0]?.fixed).toBe('SideNav(items={LINKS} current="/")')
    expect(found('AppHeader(links={LINKS} current="/")')[0]?.fixed).toBe('AppHeader(items={LINKS} current="/")')
    expect(found('Timeline(entries={EVENTS} label="x")')[0]?.fixed).toBe('Timeline(items={EVENTS} label="x")')
  })

  it('writes a shorthand out', () => {
    expect(found('Tabs({tabs} label="x" value="a")')[0]?.fixed).toBe('Tabs(items={tabs} label="x" value="a")')
  })

  it('offers no fix where items is written beside the old name', () => {
    expect(found('Tabs(tabs={A} items={B} label="x" value="a")')).toEqual([{ at: 'tabs', safe: undefined, fixed: undefined }])
  })

  it('leaves the new name, TabNav, other components and the groups of a SideNav alone', () => {
    expect(found('Tabs(items={TABS} label="x" value="a")')).toEqual([])
    expect(found('TabNav(links={LINKS} current="/")')).toEqual([])
    expect(found('Other(tabs={TABS} links={LINKS})')).toEqual([])
    expect(found('SideNav(groups={GROUPS} current="/")')).toEqual([])
  })
})
