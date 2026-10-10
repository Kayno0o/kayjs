import process from 'node:process'

// Editors taking the position as `-g file:line:column`.
const GOTO_FLAG = new Set(['code', 'code-insiders', 'codium', 'vscodium', 'cursor', 'windsurf'])
// Editors taking it appended to the file.
const POSITION_SUFFIX = new Set(['zed', 'zeditor', 'subl', 'sublime_text'])
// JetBrains IDEs, taking `--line` and `--column` before the file.
const JETBRAINS = /^(?:idea|webstorm|phpstorm|pycharm|goland|rubymine|clion|rider|rustrover)(?:64)?(?:\.sh)?$/
// code-server, which shows its window in a browser: `--reuse-window` opens the file in the one already open on its project, from a server reached over SSH as well.
const CODE_SERVER = 'code-server'
// Terminal editors, which open in the terminal `KAY_EDITOR` gives them, as `tmux new-window nvim` does.
const PLUS_LINE = new Set(['vi', 'vim', 'nvim', 'nano', 'micro', 'kak'])
const HELIX = new Set(['hx', 'helix'])
const WHITESPACE = /\s+/
const DIRECTORY = /^.*[/\\]/
// Tried in turn when no variable names an editor that opens a window of its own.
const ON_PATH = ['code', 'cursor', 'zed', 'codium', 'subl', 'webstorm', 'idea', CODE_SERVER]

// The command opening `file` at the position: `KAY_EDITOR`, then `VISUAL` or `EDITOR` when they name an editor with a window of its own, then the first found on the PATH.
// A terminal editor would take over the terminal `kay dev` prints in, so only `KAY_EDITOR` runs one; on a Linux machine with no display, as one reached over SSH, the only window that can open is code-server's.
export function editorCommand(file: string, line: number, column: number, env: Record<string, string | undefined> = process.env, platform: string = process.platform): string[] | undefined {
  const own = env.KAY_EDITOR?.trim() ?? ''

  if (own !== '')
    return positioned(own.split(WHITESPACE), file, line, column, true) ?? [...own.split(WHITESPACE), file]

  const headless = platform === 'linux' && (env.DISPLAY ?? '') === '' && (env.WAYLAND_DISPLAY ?? '') === ''
  const opens = (command: string[]) => !headless || command[0]?.replace(DIRECTORY, '') === CODE_SERVER

  for (const variable of [env.VISUAL, env.EDITOR]) {
    const named = variable?.trim() ?? ''
    const command = named === '' ? undefined : named.split(WHITESPACE)

    if (command && opens(command)) {
      const found = positioned(command, file, line, column, false)

      if (found)
        return found
    }
  }

  for (const name of headless ? [CODE_SERVER] : ON_PATH) {
    const path = Bun.which(name, { PATH: env.PATH ?? '' })

    if (path !== null)
      return positioned([path], file, line, column, false)
  }

  return undefined
}

// The command with the position added the way the editor it runs takes it, found as any of its words, so a launcher such as `kitty nvim` or `tmux new-window nvim` works too.
function positioned(command: string[], file: string, line: number, column: number, terminal: boolean): string[] | undefined {
  const at = `${file}:${line}:${column}`

  for (const word of command) {
    const name = word.replace(DIRECTORY, '')

    if (GOTO_FLAG.has(name))
      return [...command, '-g', at]

    if (POSITION_SUFFIX.has(name))
      return [...command, at]

    if (name === CODE_SERVER)
      return [...command, '--reuse-window', at]

    if (JETBRAINS.test(name))
      return [...command, '--line', String(line), '--column', String(column), file]

    if (terminal && PLUS_LINE.has(name))
      return [...command, `+${line}`, file]

    if (terminal && HELIX.has(name))
      return [...command, at]
  }

  return undefined
}
