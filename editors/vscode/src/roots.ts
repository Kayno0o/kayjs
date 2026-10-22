import { dirname, isAbsolute, join, relative, sep } from 'node:path'

export const COMMANDS = ['kay.restartServer', 'kay.check', 'kay.openDevServer', 'kay.showOutput'] as const

export type CommandId = typeof COMMANDS[number]

export interface Root {
  root: string
  // The kay CLI the root's server runs, undefined while the project has none installed.
  cli: string | undefined
  // Whether the root was found by its kay.config.ts, against a workspace folder served for the kay it has installed.
  config: boolean
}

function inside(parent: string, path: string): boolean {
  const from = relative(parent, path)

  return from === '' || (!from.startsWith('..') && !isAbsolute(from))
}

// The kay CLI a root depends on, so the server always matches the compiler its build uses: the configured one, else the nearest node_modules/kay from the root up to its workspace folder (a monorepo hoists it), else the kay repository's own.
export function serverPath(root: string, folder: string, configured: string, exists: (path: string) => boolean): string | undefined {
  if (configured !== '')
    return isAbsolute(configured) ? configured : join(folder, configured)

  for (let dir = root; inside(folder, dir); dir = dirname(dir)) {
    const installed = join(dir, 'node_modules', 'kay', 'src', 'cli.ts')

    if (exists(installed))
      return installed

    if (dir === dirname(dir))
      break
  }

  const own = join(root, 'src', 'cli.ts')

  return exists(own) ? own : undefined
}

// One language server per project: every folder holding a kay.config.ts, a project nested in another included (the outer server leaves its files to it, see `owns`), else the workspace folder itself when it has a kay to run.
export function clientRoots(folders: string[], configDirs: string[], configured: string, exists: (path: string) => boolean): Root[] {
  const found = new Map<string, Root>()
  const configs = [...new Set(configDirs)].sort()

  for (const folder of folders) {
    const inFolder = configs.filter(dir => inside(folder, dir))

    for (const root of inFolder)
      found.set(root, { root, cli: serverPath(root, folder, configured, exists), config: true })

    const cli = serverPath(folder, folder, configured, exists)

    if (inFolder.length === 0 && cli !== undefined && exists(cli))
      found.set(folder, { root: folder, cli, config: false })
  }

  return [...found.values()].sort((a, b) => a.root.localeCompare(b.root))
}

// The root whose server owns a file: the deepest one holding it.
export function rootOf(file: string, roots: string[]): string | undefined {
  return roots.filter(root => file === root || file.startsWith(root + sep)).sort((a, b) => b.length - a.length)[0]
}

// Whether the server of `root` owns a file: no deeper served root holds it, as two servers on one file would report every diagnostic twice.
export function owns(root: string, file: string, roots: string[]): boolean {
  return rootOf(file, roots.includes(root) ? roots : [...roots, root]) === root
}

// The servers whose documents a change of served roots moves: those holding a root that started or stopped, whose open files another server now owns or gives back.
export function holding(roots: string[], changed: string[]): string[] {
  return roots.filter(root => changed.some(other => other !== root && inside(root, other)))
}
