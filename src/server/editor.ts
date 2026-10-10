import process from 'node:process'

// Editors taking the position as `-g file:line:column`.
const GOTO_FLAG = new Set(['code', 'code-insiders', 'codium', 'vscodium', 'cursor', 'windsurf'])
// Editors taking it appended to the file.
const POSITION_SUFFIX = new Set(['zed', 'zeditor', 'subl', 'sublime_text'])
// JetBrains IDEs, taking `--line` and `--column` before the file.
const JETBRAINS = /^(?:idea|webstorm|phpstorm|pycharm|goland|rubymine|clion|rider|rustrover)(?:64)?(?:\.sh)?$/
const WHITESPACE = /\s+/
const DIRECTORY = /^.*[/\\]/
// Tried in turn when no variable names an editor that opens a window of its own.
const ON_PATH = ['code', 'cursor', 'zed', 'codium', 'subl', 'webstorm', 'idea']

// The command opening `file` at the position in an editor with a window of its own: `KAY_EDITOR`, then `VISUAL` or `EDITOR` when they name one, then the first found on the PATH.
// A terminal editor, as `vim`, would take over the terminal `kay dev` prints in, so only `KAY_EDITOR` runs one, with the file as its last argument.
export function editorCommand(file: string, line: number, column: number, env: Record<string, string | undefined> = process.env): string[] | undefined {
  const own = env.KAY_EDITOR?.trim() ?? ''

  if (own !== '')
    return positioned(own.split(WHITESPACE), file, line, column) ?? [...own.split(WHITESPACE), file]

  for (const variable of [env.VISUAL, env.EDITOR]) {
    const named = variable?.trim() ?? ''
    const command = named === '' ? undefined : positioned(named.split(WHITESPACE), file, line, column)

    if (command)
      return command
  }

  for (const name of ON_PATH) {
    const path = Bun.which(name, { PATH: env.PATH ?? '' })

    if (path !== null)
      return positioned([path], file, line, column)
  }

  return undefined
}

function positioned(command: string[], file: string, line: number, column: number): string[] | undefined {
  const name = command[0]?.replace(DIRECTORY, '')

  if (name === undefined)
    return undefined

  if (GOTO_FLAG.has(name))
    return [...command, '-g', `${file}:${line}:${column}`]

  if (POSITION_SUFFIX.has(name))
    return [...command, `${file}:${line}:${column}`]

  if (JETBRAINS.test(name))
    return [...command, '--line', String(line), '--column', String(column), file]

  return undefined
}
