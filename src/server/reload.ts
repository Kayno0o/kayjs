import { resolve, sep } from 'node:path'
import process from 'node:process'
import { kayLog } from '../runtime/log'

// What a `kay dev` reload lets go of: the resources a module opened, closed when that module runs again, so editing does not pile them up.
interface Owned {
  file: string
  dispose: () => unknown
}

const KAY = resolve(import.meta.dir, '..') + sep
// The files that take the top frames of a stack when an app calls a patched function: they are not the app's.
const OWN = new Set([resolve(import.meta.dir, 'reload.ts'), resolve(import.meta.dir, '../dev/preload.ts')])
const LIBRARY = /\/node_modules\//

const owned = new Set<Owned>()

// The files of the stack that are the app's, innermost first.
function appFrames(): string[] {
  const prepareStackTrace: unknown = Reflect.get(Error, 'prepareStackTrace')
  let files: string[] = []

  Error.prepareStackTrace = (_error, sites) => sites.map(site => site.getFileName() ?? '')

  try {
    files = new Error('stack').stack as unknown as string[]
  }
  finally {
    Reflect.set(Error, 'prepareStackTrace', prepareStackTrace)
  }

  return files.filter(file => file.startsWith('/') && !OWN.has(file))
}

// Who a resource belongs to: `app` is the first module outside kay, for what kay opens on a module's behalf; `direct` the module calling the function that opens it, so one a library or kay opens for itself is left; `through` the same but past the libraries, for what a library opens on a module's behalf, as a listener.
export type Owner = 'app' | 'direct' | 'through'

// Closes `dispose` when the module that owns the resource runs again, and returns what forgets it once the app closed it. Does nothing outside `kay dev`.
export function onReload(dispose: () => unknown, owner: Owner = 'app'): (() => void) | undefined {
  if (process.env.KAY_DEV_CODE === undefined)
    return undefined

  const file = ownerOf(owner)

  if (file === undefined)
    return undefined

  const entry = { file, dispose }

  owned.add(entry)

  return () => owned.delete(entry)
}

function ownerOf(owner: Owner): string | undefined {
  for (const file of appFrames()) {
    if (file.startsWith(KAY)) {
      if (owner === 'app')
        continue

      return undefined
    }

    if (owner === 'through' && LIBRARY.test(file))
      continue

    // A library's own resource may be one it keeps for every caller, which closing would leave dead.
    return owner === 'direct' && LIBRARY.test(file) ? undefined : file
  }

  return undefined
}

// Closes what the modules in `files` opened, which are about to run again.
export async function disposeOwned(files: Set<string>): Promise<void> {
  const closing = [...owned].filter(entry => files.has(entry.file))

  await Promise.all(closing.map(async (entry) => {
    owned.delete(entry)

    try {
      await entry.dispose()
    }
    catch (error) {
      kayLog('error', 'letting go of what the app opened before a reload failed', error)
    }
  }))
}
