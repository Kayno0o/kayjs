import { realpathSync } from 'node:fs'
import { isAbsolute, join, relative, sep } from 'node:path'
import { kayLog } from '../runtime/log'

// What `kay build` records of the modules a server on disk loads after `pages()`, as the `.kay` loader would compile them, so the server imports them with no compiler.
export const SERVER_RECORD = 'server-modules.json'
// The recorded modules, beside the record.
export const SERVER_DIR = 'server'
// Stands for the project root in a recorded module, which a build moved to another directory keeps.
export const ROOT_TOKEN = '__KAY_ROOT__'
// Stands for the directory above the root that holds every recorded module, when a library or a component lives outside the root.
export const UP_TOKEN = '__KAY_UP__'

// Where kay's own components are, which a record names apart from the root: they move with kay, not with the app.
export const KAY_SOURCE = `${realpathSync(join(import.meta.dir, '..'))}${sep}`

// A module by the name the record keeps it under: its path from the root, or from kay's own source for a component of kay.
export function recordName(root: string, path: string): string {
  return path.startsWith(KAY_SOURCE) ? `kay:${path.slice(KAY_SOURCE.length)}` : relative(root, path).split(sep).join('/')
}

const LOADERS = new Set(['js', 'ts', 'jsx', 'tsx'])
// Where the token stands, from the root: only `..` segments, as a library outside the root puts it above.
const ANCHOR = /^(?:\.\.\/)*\.\.$/

export interface ServerRecord {
  // What the modules were compiled with; the server compiles a module the record lacks the same way.
  settings: Record<string, string>
  placeholder?: false
  // The directory the up token stands for, from the root, when a recorded module lives above it, such as a workspace library.
  anchor?: string
  // The modules the loader changes, by their path from the root, with the file holding each, the file holding its source map when it has one and a hash of the source it was made from, which a source edited since the build does not match.
  files: Record<string, { file: string, loader: 'js' | 'ts' | 'jsx' | 'tsx', hash: string, map?: string }>
  // The project scripts the loader hands back as they are, with a hash of each, which an edit since the build, adding an `import.meta.glob` say, does not match.
  covered: Record<string, string>
  // The virtual `~icons/` modules the modules import, by specifier.
  icons: Record<string, string>
  // The library settings modules the app replaces, by their path from the root.
  replaced: string[]
}

const inBuild = (file: unknown): boolean => typeof file === 'string' && !file.includes('..') && !isAbsolute(file)
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

// A record from another version of kay, or one edited by hand, is not read.
function isRecord(record: ServerRecord): boolean {
  return isObject(record) && isObject(record.settings) && isObject(record.files) && isObject(record.covered) && isObject(record.icons)
    && Object.values(record.settings).every(value => typeof value === 'string')
    && (record.anchor === undefined || (typeof record.anchor === 'string' && ANCHOR.test(record.anchor)))
    && Object.values(record.files).every(found => isObject(found) && inBuild(found.file) && LOADERS.has(found.loader) && typeof found.hash === 'string' && (found.map === undefined || inBuild(found.map)))
    && Object.values(record.covered).every(hash => typeof hash === 'string')
    && Array.isArray(record.replaced) && record.replaced.every(file => typeof file === 'string')
    && Object.values(record.icons).every(inBuild)
}

// Undefined for a build that wrote none, which then loads its modules through the `.kay` loader.
export async function readServerRecord(output: string): Promise<ServerRecord | undefined> {
  const file = Bun.file(join(output, SERVER_RECORD))

  if (!await file.exists())
    return undefined

  try {
    const record = await file.json() as ServerRecord

    if (!isRecord(record))
      throw new Error('shape')

    return record
  }
  catch {
    kayLog('warn', `${SERVER_RECORD} in ${output} is unreadable, so the modules are compiled as they load; run kay build again`)

    return undefined
  }
}
