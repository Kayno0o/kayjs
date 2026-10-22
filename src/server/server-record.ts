import { join } from 'node:path'
import { kayLog } from '../runtime/log'

// What `kay build` records of the modules a server on disk loads after `pages()`, as the `.kay` loader would compile them, so the server imports them with no compiler.
export const SERVER_RECORD = 'server-modules.json'
// The recorded modules, beside the record.
export const SERVER_DIR = 'server'
// Stands for the project root in a recorded module, which a build moved to another directory keeps.
export const ROOT_TOKEN = '__KAY_ROOT__'

export interface ServerRecord {
  // What the modules were compiled with; the server compiles a module the record lacks the same way.
  settings: Record<string, string>
  placeholder?: false
  // The modules the loader changes, by their path from the root, with the file holding each and a hash of the source it was made from, which a source edited since the build does not match.
  files: Record<string, { file: string, loader: 'js' | 'ts' | 'jsx' | 'tsx', hash: string }>
  // The project scripts the loader hands back as they are.
  covered: string[]
  // The virtual `~icons/` modules the modules import, by specifier.
  icons: Record<string, string>
  // The library settings modules the app replaces, by their path from the root.
  replaced: string[]
}

// Undefined for a build that wrote none, which then loads its modules through the `.kay` loader.
export async function readServerRecord(output: string): Promise<ServerRecord | undefined> {
  const file = Bun.file(join(output, SERVER_RECORD))

  if (!await file.exists())
    return undefined

  try {
    return await file.json() as ServerRecord
  }
  catch {
    kayLog('warn', `${SERVER_RECORD} in ${output} is unreadable, so the modules are compiled as they load; run kay build again`)

    return undefined
  }
}
