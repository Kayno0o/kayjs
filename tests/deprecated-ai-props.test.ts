import { describe, expect, it } from 'bun:test'
import { compileKay } from '../src/compiler'

const IMPORTS = [
  'import Chat from \'@kaynooo/kayjs-ai/chat.kay\'',
  'import Launcher from \'@kaynooo/kayjs-ai/chat-launcher.kay\'',
  'import Other from \'./other.kay\'',
].join('\n')

// What the lint reports in a template, with the text of each safe fix applied to the source.
function found(template: string) {
  const source = `---\n${IMPORTS}\n---\n${template}\n`
  const diagnostics = compileKay(source, 'props.kay', { check: true }).diagnostics.filter(d => d.code === 'deprecated-ai-props')

  return diagnostics.map((d) => {
    const fix = d.fixes?.[0]
    const fixed = fix === undefined ? undefined : [...fix.edits].sort((a, b) => b.start - a.start).reduce((text, edit) => `${text.slice(0, edit.start)}${edit.text}${text.slice(edit.end)}`, source).split('---\n')[2]!.trim()

    return { at: source.slice(d.start, d.end), safe: fix?.safe, fixed }
  })
}

describe('deprecated-ai-props', () => {
  it('renames reasoning and thinkingLabel on a Chat and a ChatLauncher', () => {
    expect(found('Chat(action={reply} reasoning={false} thinkingLabel="Wait")')).toEqual([
      { at: 'reasoning', safe: true, fixed: 'Chat(action={reply} showReasoning={false} thinkingLabel="Wait")' },
      { at: 'thinkingLabel', safe: true, fixed: 'Chat(action={reply} reasoning={false} waitingLabel="Wait")' },
    ])
    expect(found('Launcher(action={reply} reasoning={shown})')[0]?.fixed).toBe('Launcher(action={reply} showReasoning={shown})')
  })

  it('writes a shorthand out', () => {
    expect(found('Chat(action={reply} {reasoning})')[0]?.fixed).toBe('Chat(action={reply} showReasoning={reasoning})')
  })

  it('offers no fix where the new name is written too', () => {
    expect(found('Chat(action={reply} reasoning={false} showReasoning)')).toEqual([{ at: 'reasoning', safe: undefined, fixed: undefined }])
    expect(found('Chat(action={reply} thinkingLabel="a" waitingLabel="b")')).toEqual([{ at: 'thinkingLabel', safe: undefined, fixed: undefined }])
  })

  it('leaves the new names and other components alone', () => {
    expect(found('Chat(action={reply} showReasoning={false} waitingLabel="Wait" reasoningLabel="Thoughts")')).toEqual([])
    expect(found('Other(reasoning={false} thinkingLabel="x")')).toEqual([])
  })
})
