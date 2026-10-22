import { dirname } from 'node:path'
import { KAY_FILE, scriptLoader } from '../build/files'
import { GLOB_CALL, globbedFiles } from '../build/glob'
import { fences, packageRoot } from '../build/libraries'

// The files the `import.meta.glob` calls of a module expand to. Apart from the routes' scan, as the glob reader parses with Babel, which a served app only loads once its reach walk needs it.
export function globEdges(source: string, file: string, root: string | undefined): string[] {
  if (!source.includes(GLOB_CALL))
    return []

  const kay = KAY_FILE.test(file)

  return globbedFiles(kay ? fences(source) : source, file, root ?? packageRoot(dirname(file)), kay ? 'ts' : scriptLoader(file)) ?? []
}
