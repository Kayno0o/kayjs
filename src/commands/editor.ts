import type { Editor } from '../editors'
import type { Command } from './command'
import { EDITORS, findEditors, installEditor, printSetups } from '../editors'
import { formatOption, printDocument, printFailure, projectRoot } from './command'

// Sets up the editors that read `.kay` through tree-sitter and the language server: the files they need, written in their own configuration.
export const editorInstall: Command = {
  usage: 'editor install [helix|zed] [dir] [--format text|json]',
  options: { format: { type: 'string' } },
  positionals: 2,
  run: async ({ values, positionals: [wanted, path] }, refuse) => {
    const format = formatOption('editor install', values.format)

    if (format === undefined)
      return 1

    if (wanted !== undefined && !EDITORS.includes(wanted as Editor))
      return refuse(`${wanted} is none of ${EDITORS.join(', ')}`)

    const root = projectRoot('editor install', path, format)

    if (root === undefined)
      return 1

    const editors = wanted === undefined ? findEditors() : [wanted as Editor]

    if (editors.length === 0) {
      printFailure('editor install', `neither ${EDITORS.join(' nor ')} is on the PATH: name the editor to set it up anyway`, format)

      return 1
    }

    const setups = []

    for (const editor of editors) {
      try {
        setups.push(await installEditor(editor, { root }))
      }
      catch (error) {
        printFailure('editor install', error, format)

        return 1
      }
    }

    if (format === 'json') {
      printDocument({ editors: setups })

      return 0
    }

    printSetups(setups)

    return 0
  },
}
