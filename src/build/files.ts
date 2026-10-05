import type { Dirent } from 'node:fs'
import { mkdir, readdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'

// Never source at any depth: dependencies, kay's own output and version control.
const ALWAYS_IGNORED = new Set(['node_modules', '.kay', '.git'])
// The output a build leaves at the project root; anywhere deeper `dist` is an ordinary directory, `src/routes/dist` a page directory.
const ROOT_IGNORED = new Set(['dist'])

export const TSCONFIG = 'tsconfig.json'

const TYPESCRIPT = /\.[cm]?ts$/
const TSX = /\.tsx$/
const JSX = /\.jsx$/
const KAY_FILE = /\.kay$/
const transpilers = new Map<Bun.JavaScriptLoader, Bun.Transpiler>()

// One transpiler per loader, shared by everything reading a module's imports.
export function transpilerFor(loader: Bun.JavaScriptLoader): Bun.Transpiler {
  let found = transpilers.get(loader)

  if (!found)
    transpilers.set(loader, found = new Bun.Transpiler({ loader }))

  return found
}

export function scriptLoader(path: string): Bun.JavaScriptLoader {
  if (TYPESCRIPT.test(path))
    return 'ts'

  if (TSX.test(path))
    return 'tsx'

  return JSX.test(path) ? 'jsx' : 'js'
}

export const IGNORED_DIRS = new Set([...ALWAYS_IGNORED, ...ROOT_IGNORED])

export interface FindOptions {
  // Whether `root` is a project's, whose build output `dist` is then skipped rather than searched.
  project?: boolean
  // Whether a directory holding its own tsconfig.json, another project, is left out.
  ownOnly?: boolean
}

// Every .kay file under `root`, skipping dependencies and generated output without walking into them.
export async function findKayFiles(root: string, options: FindOptions = {}): Promise<string[]> {
  return findProjectFiles(root, KAY_FILE, options)
}

// Every file under `root` whose name `matches`, skipping as findKayFiles does.
export async function findProjectFiles(root: string, matches: RegExp, { project = false, ownOnly = false }: FindOptions = {}): Promise<string[]> {
  const files: string[] = []
  const walk = async (dir: string) => {
    const entries = await readable(dir)

    if (ownOnly && dir !== root && entries.some(entry => entry.isFile() && entry.name === TSCONFIG))
      return

    await Promise.all(entries.map(async (entry) => {
      const path = join(dir, entry.name)

      if (entry.isDirectory()) {
        if (!ALWAYS_IGNORED.has(entry.name) && !(project && dir === root && ROOT_IGNORED.has(entry.name)))
          await walk(path)
      }
      else if (matches.test(entry.name)) {
        files.push(path)
      }
    }))
  }

  await walk(root)

  return files.sort()
}

// A directory the user cannot read holds nothing the project could compile: a container writes one into a repository when a service bind-mounts its data there.
async function readable(dir: string): Promise<Dirent[]> {
  try {
    return await readdir(dir, { withFileTypes: true })
  }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EACCES' && (error as NodeJS.ErrnoException).code !== 'EPERM')
      throw error

    return []
  }
}

// Leaves an unchanged file alone, so watchers and editors reading it see no change.
export async function writeIfChanged(path: string, content: string) {
  const file = Bun.file(path)

  if (await file.exists() && await file.text() === content)
    return

  await mkdir(dirname(path), { recursive: true })
  await Bun.write(path, content)
}
