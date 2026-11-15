import { describe, expect, it } from 'bun:test'
import { compileKay } from '../src/compiler'

const IMPORTS = [
  'import Chat from \'@kayjs/ai/chat.kay\'',
  'import Sources from \'@kayjs/ai/chat-sources.kay\'',
  'import Other from \'./other.kay\'',
].join('\n')

// What the lint reports in a template, with the text of each safe fix applied to the source.
function found(template: string) {
  const source = `---\n${IMPORTS}\n---\n${template}\n`
  const diagnostics = compileKay(source, 'links.kay', { check: true }).diagnostics.filter(d => d.code === 'deprecated-ai-links')

  return diagnostics.map((d) => {
    const fix = d.fixes?.[0]
    const fixed = fix === undefined ? undefined : [...fix.edits].sort((a, b) => b.start - a.start).reduce((text, edit) => `${text.slice(0, edit.start)}${edit.text}${text.slice(edit.end)}`, source).split('---\n')[2]!.trim()

    return { at: source.slice(d.start, d.end), safe: fix?.safe, fixed }
  })
}

describe('deprecated-ai-links', () => {
  it('writes links="here" and links="apart" of a Chat as newTab', () => {
    expect(found('Chat(action={send} links="here" attach)')).toEqual([{ at: 'links', safe: true, fixed: 'Chat(action={send} newTab="auto" attach)' }])
    expect(found('Chat(action={send} links="apart")')[0]?.fixed).toBe('Chat(action={send} newTab={true})')
  })

  it('writes the here of Sources as newTab, a bare one, an expression and a shorthand', () => {
    expect(found('Sources(sources={list} label="Sources" here)')[0]?.fixed).toBe('Sources(sources={list} label="Sources" newTab="auto")')
    expect(found('Sources(sources={list} here={local})')[0]?.fixed).toBe('Sources(sources={list} newTab={local ? \'auto\' : true})')
    expect(found('Sources(sources={list} {here})')[0]?.fixed).toBe('Sources(sources={list} newTab={here ? \'auto\' : true})')
    expect(found('Sources(sources={list} here={props.local})')[0]?.fixed).toBe('Sources(sources={list} newTab={props.local ? \'auto\' : true})')
    expect(found('Sources(sources={list} here={a ? b : c})')[0]?.fixed).toBe('Sources(sources={list} newTab={(a ? b : c) ? \'auto\' : true})')
  })

  it('reports with no fix where newTab is written already, or the value is not one of the two words', () => {
    expect(found('Chat(action={send} links="here" newTab={false})')).toEqual([{ at: 'links', safe: undefined, fixed: undefined }])
    expect(found('Chat(action={send} links={mode})')).toEqual([{ at: 'links', safe: undefined, fixed: undefined }])
  })

  it('leaves newTab, other components and other props alone', () => {
    expect(found('Chat(action={send} newTab="auto")')).toEqual([])
    expect(found('Other(links="here" here)')).toEqual([])
    expect(found('Sources(sources={list} links="here")')).toEqual([])
  })
})
