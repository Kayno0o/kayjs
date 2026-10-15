// What a checking script read, which the editor's language server keys the script's last result on: the script lists the files it loaded, the parent stamps them and runs it again only when a stamp moved.
import { readdirSync, realpathSync, statSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { GLOBBED } from '../build/glob'

// Starts the line a checking script lists the files it read on.
export const FILES_MARKER = 'kay-probe-files:'
// The files every probe leans on beside the modules it loads: the config naming its inputs, and what resolves the imports.
// Bun reads the environment files and `bunfig.toml` into a script started in the project, and a lockfile changes what the installed packages are.
const ROOT_FILES = ['kay.config.ts', 'tsconfig.json', 'package.json', 'bun.lock', 'bunfig.toml', '.env', '.env.local', '.env.development', '.env.production', '.env.test']
// Folders a walk of a folder of entries has no reason to enter.
const SKIPPED = new Set(['node_modules', '.kay'])
const QUERY = /\?.*$/
const OWN_SOURCE = `${resolve(import.meta.dir, '..')}${sep}`

// The modules loaded in this process that are the project's, with the files and folders `read` names, which may not exist yet: a file created later is a change, as one edited is, and so is one added where an `import.meta.glob` looks.
// A file a module reads by itself, with `readFileSync` or `Bun.file`, is not seen: `read` names what kay's own scripts read that way.
export function loadedFiles(root: string, read: string[]): string[] {
  // What kay writes under the project's `.kay` is its own.
  const generated = [join(root, '.kay', sep), join(realpathSync(root), '.kay', sep)]
  // A module keyed with a query, such as a component loaded for its island, is the file before it.
  const modules = Object.keys(require.cache).map(path => path.replace(QUERY, '')).filter((path) => {
    return path.startsWith(sep) && !path.startsWith(OWN_SOURCE) && !path.split(sep).includes('node_modules') && !generated.some(folder => path.startsWith(folder))
  })

  return [...new Set([...ROOT_FILES.map(file => join(root, file)), ...modules, ...GLOBBED, ...read])]
}

// Where a file is on disk as far as a change can tell: its inode, modification time and size, a folder's entries each in turn; `-` for a path that is not there.
// A path that cannot be read gives a stamp equal to no other and counts as newest, so its script runs again and is not remembered.
export function stampOf(paths: string[]): { stamp: string, newest: number } {
  let newest = 0
  const parts: string[] = []
  const seen = new Set<string>()
  const add = (path: string) => {
    try {
      const stat = statSync(path, { throwIfNoEntry: false })

      if (!stat) {
        parts.push(`${path}\0-`)

        return
      }

      newest = Math.max(newest, stat.mtimeMs, stat.ctimeMs)
      parts.push(`${path}\0${stat.ino}\0${stat.mtimeMs}\0${stat.size}`)

      // A folder is walked once, however many links lead to it.
      if (stat.isDirectory() && !seen.has(`${stat.dev}:${stat.ino}`)) {
        seen.add(`${stat.dev}:${stat.ino}`)

        for (const name of readdirSync(path).toSorted()) {
          if (!SKIPPED.has(name))
            add(join(path, name))
        }
      }
    }
    catch {
      newest = Number.POSITIVE_INFINITY
      parts.push(`${path}\0unreadable ${performance.now()}`)
    }
  }

  for (const path of paths)
    add(path)

  return { stamp: parts.join('\n'), newest }
}
