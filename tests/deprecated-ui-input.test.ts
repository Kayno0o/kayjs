import { describe, expect, it } from 'bun:test'
import { compileKay } from '../src/compiler'

const IMPORTS = [
  'import Toggle from \'@kayjs/ui/toggle.kay\'',
  'import Combobox from \'@kayjs/ui/combobox.kay\'',
  'import TextInput from \'@kayjs/ui/text-input.kay\'',
  'import Other from \'./other.kay\'',
].join('\n')

// What the lint reports in a template, with the text of the first fix applied to the source.
function found(template: string) {
  const source = `---\n${IMPORTS}\n---\n${template}\n`
  const diagnostics = compileKay(source, 'input.kay', { check: true }).diagnostics.filter(d => d.code === 'deprecated-ui-input')
  const fix = diagnostics.find(d => d.fixes?.[0])?.fixes?.[0]
  const fixed = fix === undefined ? undefined : [...fix.edits].sort((a, b) => b.start - a.start).reduce((text, edit) => `${text.slice(0, edit.start)}${edit.text}${text.slice(edit.end)}`, source).split('---\n')[2]!.trim()

  return { at: diagnostics.map(d => source.slice(d.start, d.end)), safe: fix?.safe, fixed }
}

describe('deprecated-ui-input', () => {
  it('writes the attributes that reached the input into inputProps', () => {
    expect(found('Toggle(label="Alerts" id="alerts")')).toEqual({ at: ['id'], safe: true, fixed: 'Toggle(label="Alerts" inputProps={{ id: "alerts" }})' })
  })

  it('gathers several attributes into one object', () => {
    const { at, fixed } = found('Toggle(label="A" id="a" data-track={tag} title="T" checked)')

    expect(at).toEqual(['id', 'data-track', 'title'])
    expect(fixed).toBe('Toggle(label="A" inputProps={{ id: "a", "data-track": tag, title: "T" }} checked)')
  })

  it('writes the #id shorthand into inputProps', () => {
    expect(found('Toggle#alerts(label="A")').fixed).toBe('Toggle(inputProps={{ id: "alerts" }} label="A")')
    expect(found('Toggle#alerts').fixed).toBe('Toggle(inputProps={{ id: "alerts" }})')
    expect(found('Toggle#alerts(label="A" data-x="1")').fixed).toBe('Toggle(label="A" inputProps={{ id: "alerts", "data-x": "1" }})')
    expect(found('Combobox#list(label="x" options={[]})').at).toEqual([])
  })

  it('writes a braced shorthand, a duplicate id and attributes on their own lines', () => {
    expect(found('Toggle({id} label="a")').fixed).toBe('Toggle(inputProps={{ id: id }} label="a")')
    expect(found('Toggle(label="a" {title} id="x")').fixed).toBe('Toggle(label="a" inputProps={{ title: title, id: "x" }})')
    expect(found('Toggle#a(id="b")').fixed).toBe('Toggle(inputProps={{ id: "b" }})')
    expect(found('Toggle(\n  label="a"\n  id="x"\n  data-y="1"\n)').fixed).toBe('Toggle(\n  label="a"\n  inputProps={{ id: "x", "data-y": "1" }}\n)')
  })

  it('leaves a tooltip with the input', () => {
    expect(found('Toggle(label="a" data-tooltip="x" data-hint="y")').at).toEqual([])
  })

  it('offers no fix beside an inputProps', () => {
    expect(found('Toggle(label="A" id="a" inputProps={{ name: "x" }})')).toEqual({ at: ['id'], safe: undefined, fixed: undefined })
  })

  it('leaves a Combobox id, other components and the attributes the input keeps alone', () => {
    expect(found('Combobox(id="list" label="x" options={[]})').at).toEqual([])
    expect(found('Toggle(label="A" name="a" aria-describedby="x" disabled)').at).toEqual([])
    expect(found('TextInput(id="a")').at).toEqual([])
    expect(found('Other(id="a")').at).toEqual([])
  })
})
