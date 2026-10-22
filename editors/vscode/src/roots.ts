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

// One language server per project: every folder holding a kay.config.ts, the outermost when one holds another, else the workspace folder itself when it has a kay to run.
export function clientRoots(folders: string[], configDirs: string[], configured: string, exists: (path: string) => boolean): Root[] {
  const found = new Map<string, Root>()
  const outer = [...new Set(configDirs)].sort().filter((dir, index, all) => !all.slice(0, index).some(parent => inside(parent, dir)))

  for (const folder of folders) {
    const configs = outer.filter(dir => inside(folder, dir))

    for (const root of configs)
      found.set(root, { root, cli: serverPath(root, folder, configured, exists), config: true })

    const cli = serverPath(folder, folder, configured, exists)

    if (configs.length === 0 && cli !== undefined && exists(cli))
      found.set(folder, { root: folder, cli, config: false })
  }

  return [...found.values()].sort((a, b) => a.root.localeCompare(b.root))
}

// The root whose server owns a file: the deepest one holding it.
export function rootOf(file: string, roots: string[]): string | undefined {
  return roots.filter(root => file === root || file.startsWith(root + sep)).sort((a, b) => b.length - a.length)[0]
}
