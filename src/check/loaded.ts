// What a checking script read, which the editor's language server keys the script's last result on: the script lists the files it loaded, the parent stamps them and runs it again only when a stamp moved.
import { readdirSync, statSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'

// Starts the line a checking script lists the files it read on.
export const FILES_MARKER = 'kay-probe-files:'
// The files every probe leans on beside the modules it loads: the config naming its inputs, and what resolves the imports.
const ROOT_FILES = ['kay.config.ts', 'tsconfig.json', 'package.json']
const QUERY = /\?.*$/
const OWN_SOURCE = `${resolve(import.meta.dir, '..')}${sep}`

// The modules loaded in this process that are the project's, with the files and folders `read` names, which may not exist yet: a file created later is a change, as one edited is.
export function loadedFiles(root: string, read: string[]): string[] {
  // What kay writes under the project's `.kay` is its own.
  const generated = join(root, '.kay', sep)
  // A module keyed with a query, such as a component loaded for its island, is the file before it.
  const modules = Object.keys(require.cache).map(path => path.replace(QUERY, '')).filter((path) => {
    return path.startsWith(sep) && !path.startsWith(OWN_SOURCE) && !path.split(sep).includes('node_modules') && !path.startsWith(generated)
  })

  return [...new Set([...ROOT_FILES.map(file => join(root, file)), ...modules, ...read])]
}

// Where a file is on disk as far as a change can tell: its inode, modification time and size, a folder's entries each in turn; `-` for a path that is not there.
export function stampOf(paths: string[]): { stamp: string, newest: number } {
  let newest = 0
  const parts: string[] = []
  const add = (path: string) => {
    const stat = statSync(path, { throwIfNoEntry: false })

    if (!stat) {
      parts.push(`${path}\0-`)

      return
    }

    newest = Math.max(newest, stat.mtimeMs, stat.ctimeMs)
    parts.push(`${path}\0${stat.ino}\0${stat.mtimeMs}\0${stat.size}`)

    if (stat.isDirectory()) {
      for (const name of readdirSync(path).toSorted())
        add(join(path, name))
    }
  }

  for (const path of paths)
    add(path)

  return { stamp: parts.join('\n'), newest }
}
