import { resolve, sep } from 'node:path'
import process from 'node:process'
import { kayLog } from '../runtime/log'

// What a `kay dev` reload lets go of: the resources a module opened, closed when that module runs again, so editing does not pile them up.
interface Owned {
  file: string
  dispose: () => unknown
}

const KAY = resolve(import.meta.dir, '..') + sep
// The files of kay that take the stack's top frames: they are not the app's.
const OWN = /\/(?:server\/reload|dev\/preload)\.ts$/
const FRAME = /\(?(?:file:\/\/)?(\/[^\s()]+?):\d+:\d+\)?$/

const owned = new Set<Owned>()

// The files of the stack that are the app's, innermost first.
function appFrames(): string[] {
  const files: string[] = []

  for (const line of (new Error('stack').stack ?? '').split('\n').slice(1)) {
    const file = FRAME.exec(line)?.[1]

    if (file !== undefined && !(file.startsWith(KAY) && OWN.test(file)))
      files.push(file)
  }

  return files
}

// Who a resource belongs to: `app` is the first module outside kay, for what kay opens on a module's behalf; `direct` the module calling the function that opens it, so one a library or kay opens for itself is left; `through` the same but past the libraries, for what a library opens on a module's behalf, as a listener.
export type Owner = 'app' | 'direct' | 'through'

const LIBRARY = /\/node_modules\//

// Closes `dispose` when the module that owns the resource runs again. Does nothing outside `kay dev`.
export function onReload(dispose: () => unknown, owner: Owner = 'app'): void {
  if (process.env.KAY_DEV_CODE === undefined)
    return

  const file = ownerOf(owner)

  if (file !== undefined)
    owned.add({ file, dispose })
}

function ownerOf(owner: Owner): string | undefined {
  for (const file of appFrames()) {
    if (file.startsWith(KAY)) {
      if (owner === 'app')
        continue

      return undefined
    }

    if (owner !== 'through' || !LIBRARY.test(file))
      return file
  }

  return undefined
}

// Closes what the modules in `files` opened, which are about to run again.
export async function disposeOwned(files: Set<string>): Promise<void> {
  for (const entry of owned) {
    if (!files.has(entry.file))
      continue

    owned.delete(entry)

    try {
      await entry.dispose()
    }
    catch (error) {
      kayLog('error', 'letting go of what the app opened before a reload failed', error)
    }
  }
}
