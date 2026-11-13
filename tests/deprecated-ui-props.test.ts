import { describe, expect, it } from 'bun:test'
import { compileKay } from '../src/compiler'

const IMPORTS = [
  'import Dialog from \'@kayjs/ui/dialog.kay\'',
  'import SidePanel from \'@kayjs/ui/side-panel.kay\'',
  'import FormDialog from \'@kayjs/ui/form-dialog.kay\'',
  'import Stat from \'@kayjs/ui/stat.kay\'',
  'import Chat from \'@kayjs/ai/chat.kay\'',
  'import Launcher from \'@kayjs/ai/chat-launcher.kay\'',
  'import Other from \'./other.kay\'',
].join('\n')

// What the lint reports in a template, with the text of each safe fix applied to the source.
function found(template: string) {
  const source = `---\n${IMPORTS}\n---\n${template}\n`
  const diagnostics = compileKay(source, 'props.kay', { check: true }).diagnostics.filter(d => d.code === 'deprecated-ui-props')

  return diagnostics.map((d) => {
    const fix = d.fixes?.[0]
    const fixed = fix === undefined ? undefined : [...fix.edits].sort((a, b) => b.start - a.start).reduce((text, edit) => `${text.slice(0, edit.start)}${edit.text}${text.slice(edit.end)}`, source).split('---\n')[2]!.trim()

    return { at: source.slice(d.start, d.end), safe: fix?.safe, fixed }
  })
}

describe('deprecated-ui-props: title', () => {
  it('writes the heading block as the title block and the title string as the label', () => {
    expect(found('Dialog(open={true} title="Rename" onOpenChange={() => undefined})\n  @heading\n    em Mars')).toEqual([{ at: 'heading', safe: true, fixed: 'Dialog(open={true} label="Rename" onOpenChange={() => undefined})\n  @title\n    em Mars' }])
  })

  it('does the same on a SidePanel and a FormDialog', () => {
    expect(found('SidePanel(open={true} title="Venus")\n  @heading\n    em Venus')[0]?.fixed).toBe('SidePanel(open={true} label="Venus")\n  @title\n    em Venus')
    expect(found('FormDialog(open={true} title={name} action={save})\n  @heading\n    em x')[0]?.fixed).toBe('FormDialog(open={true} label={name} action={save})\n  @title\n    em x')
  })

  it('renames a heading attribute, and writes its shorthand out', () => {
    expect(found('Dialog(open={true} title="Rename" heading={mark})')[0]?.fixed).toBe('Dialog(open={true} label="Rename" title={mark})')
    expect(found('Dialog(open={true} title="Rename" {heading})')[0]?.fixed).toBe('Dialog(open={true} label="Rename" title={heading})')
  })

  it('offers no fix where a title block or a label is already written', () => {
    expect(found('Dialog(open={true} label="x")\n  @heading\n    em a')).toEqual([{ at: 'heading', safe: undefined, fixed: undefined }])
    expect(found('Dialog(open={true})\n  @title\n    em a\n  @heading\n    em b')).toEqual([{ at: 'heading', safe: undefined, fixed: undefined }])
  })

  it('leaves the title, the label and other components alone', () => {
    expect(found('Dialog(open={true} title="x")\n  p body')).toEqual([])
    expect(found('Dialog(open={true} label="x")\n  @title\n    em a')).toEqual([])
    expect(found('Other(heading="x")\n  @heading\n    em a')).toEqual([])
  })
})

describe('deprecated-ui-props: layout', () => {
  it('renames variant on a Stat, a Chat and a ChatLauncher', () => {
    expect(found('Stat(value={1} variant="tile")')).toEqual([{ at: 'variant', safe: true, fixed: 'Stat(value={1} layout="tile")' }])
    expect(found('Chat(action={reply} variant="plain")')[0]?.fixed).toBe('Chat(action={reply} layout="plain")')
    expect(found('Launcher(action={reply} variant={look})')[0]?.fixed).toBe('Launcher(action={reply} layout={look})')
  })

  it('writes the shorthand out', () => {
    expect(found('Stat(value={1} {variant})')[0]?.fixed).toBe('Stat(value={1} layout={variant})')
  })

  it('offers no fix where layout is written, and leaves the new name and other components alone', () => {
    expect(found('Stat(value={1} variant="tile" layout="tile")')).toEqual([{ at: 'variant', safe: undefined, fixed: undefined }])
    expect(found('Stat(value={1} layout="tile")')).toEqual([])
    expect(found('Other(variant="tile")')).toEqual([])
    expect(found('Dialog(open={true} title="x" variant="y")')).toEqual([])
  })
})
