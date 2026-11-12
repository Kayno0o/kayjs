import type { Diagnostic, KayFile } from './ast'

const SPELLED_OUT = /^---[ \t]+script\b/

// `--- script` opening a file: the bare `---` is the same fence, and only a script that follows a named fence needs the word, as there a bare line would close the named one.
export function spelledOutScriptFence(file: KayFile): Diagnostic[] {
  const line = file.scriptLine

  if (!line || file.source.slice(0, line.start).trim() !== '')
    return []

  const spelled = SPELLED_OUT.exec(file.source.slice(line.start, line.end))

  if (!spelled)
    return []

  return [{
    start: line.start,
    end: line.start + spelled[0].length,
    code: 'deprecated-script-fence',
    checkOnly: true,
    message: '`--- script` is `---` spelled out, deprecated since 1.102',
    help: 'write `---`: the word is only needed for a script that follows a `--- server` or `--- module` fence',
    fixes: [{ title: 'Write `---`', safe: true, edits: [{ start: line.start + 3, end: line.start + spelled[0].length, text: '' }] }],
  }]
}
