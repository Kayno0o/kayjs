import { describe, expect, it } from 'bun:test'
import { compileKay } from '../src/compiler'

const IMPORTS = [
  'import Chat from \'@kayjs/ai/chat.kay\'',
  'import Launcher from \'@kayjs/ai/chat-launcher.kay\'',
  'import Panel from \'@kayjs/ai/chat-panel.kay\'',
  'import Other from \'./other.kay\'',
].join('\n')

// What the lint reports in a template, with the text of each safe fix applied to the source.
function found(template: string) {
  const source = `---\n${IMPORTS}\n---\n${template}\n`
  const diagnostics = compileKay(source, 'labels.kay', { check: true }).diagnostics.filter(d => d.code === 'deprecated-ai-labels')

  return diagnostics.map((d) => {
    const fix = d.fixes?.[0]
    const fixed = fix === undefined ? undefined : [...fix.edits].sort((a, b) => b.start - a.start).reduce((text, edit) => `${text.slice(0, edit.start)}${edit.text}${text.slice(edit.end)}`, source).split('---\n')[2]!.trim()

    return { at: source.slice(d.start, d.end), safe: fix?.safe, fixed }
  })
}

describe('deprecated-ai-labels', () => {
  it('writes the label props of a Chat as one labels object keyed as its messages are', () => {
    expect(found('Chat(action={send} sendLabel="Go" stopLabel="Halt" placeholder="Ask")')).toEqual([{ at: 'sendLabel', safe: true, fixed: 'Chat(action={send} labels={{ send: "Go", stop: "Halt" }} placeholder="Ask")' }])
  })

  it('moves the expressions and the shorthand as they are written', () => {
    expect(found('Chat(action={send} editLabel={word("edit")} {saveLabel} class="x")')).toEqual([{ at: 'editLabel', safe: true, fixed: 'Chat(action={send} labels={{ edit: word("edit"), save: saveLabel }} class="x")' }])
  })

  it('gives waitingLabel and failureLabel the key of their message', () => {
    expect(found('Chat(action={send} waitingLabel="One moment" failureLabel="Oops")')[0]?.fixed).toBe('Chat(action={send} labels={{ thinking: "One moment", error: "Oops" }})')
  })

  it('takes the launcher\'s own four texts, and the panel\'s five', () => {
    expect(found('Launcher(action={send} openLabel="Ask" closeLabel="Hide" newLabel="Reset")')[0]?.fixed).toBe('Launcher(action={send} labels={{ open: "Ask", close: "Hide", new: "Reset" }})')
    expect(found('Panel(openLabel="Ask" expandLabel="Bigger")')[0]?.fixed).toBe('Panel(labels={{ open: "Ask", expand: "Bigger" }})')
  })

  it('removes a prop on its own line with the line, keeping the others', () => {
    expect(found('Chat(\n  action={send}\n  sendLabel="Go"\n  attach\n  stopLabel="Halt"\n)')[0]?.fixed).toBe('Chat(\n  action={send}\n  labels={{ send: "Go", stop: "Halt" }}\n  attach\n)')
  })

  it('reports with no fix where labels is written already, or a prop holds no value', () => {
    expect(found('Chat(action={send} labels={{ send: "Go" }} stopLabel="Halt")')).toEqual([{ at: 'stopLabel', safe: undefined, fixed: undefined }])
    expect(found('Chat(action={send} sendLabel)')).toEqual([{ at: 'sendLabel', safe: undefined, fixed: undefined }])
  })

  it('leaves labels, other components and props of another meaning alone', () => {
    expect(found('Chat(action={send} labels={{ send: "Go" }} label="Help" toolLabels={{}})')).toEqual([])
    expect(found('Other(sendLabel="Go")')).toEqual([])
    expect(found('Panel(fieldLabel="Go")')).toEqual([])
  })
})
