import type { KayConfig } from '../config'
import type { RouteMount } from '../server/routes'
import { existsSync, realpathSync } from 'node:fs'
import { basename, sep } from 'node:path'
import { projectPaths } from '../project'
import { routeMounts } from '../server/routes'

// The directories holding the project's pages: its routes directory and the ones its extensions mount, not the folder of an outer layout, whose other `.kay` files are components.
export function pageDirs(root: string, config: Pick<KayConfig, 'dirs' | 'contentConfig' | 'entry' | 'extensions'>): string[] {
  return [projectPaths(root, config).routes, ...routeMounts(root, config.extensions, false).filter(mount => mount.outer === undefined).map(mount => mount.dir)]
}

// The page directories of a check that has the routes directory and the mounts read already: the same ones `pageDirs` lists.
export function mountedPageDirs(routesDir: string, mounts: readonly RouteMount[]): string[] {
  return [routesDir, ...mounts.filter(mount => mount.outer === undefined).map(mount => mount.dir)]
}

// The real path of each page directory, worked out once as a compile asks for every file.
const realDirs = new Map<string, string>()

export function realpathOrSelf(file: string): string {
  try {
    return realpathSync(file)
  }
  catch {
    return file
  }
}

// Whether the file sits under one of the directories, compared by real path as a linked routes directory or file names them.
function inPages(file: string, dirs: readonly string[]): boolean {
  const real = realpathOrSelf(file)

  return dirs.some((dir) => {
    let found = realDirs.get(dir)

    if (found === undefined) {
      found = realpathOrSelf(dir)

      // A directory not there yet is looked for again.
      if (found !== dir || existsSync(dir))
        realDirs.set(dir, found)
    }

    return real.startsWith(found + sep)
  })
}

// Whether the file is a page: under a page directory and routable, so a `_` file (a partial, a layout, a special page) is not one, whatever the routes directory holds.
// Every caller handing a file to the compiler passes this as its `page`, so the build, the check and the commands agree on what a page is.
export function isPageFile(file: string, dirs: readonly string[]): boolean {
  return !basename(file).startsWith('_') && inPages(file, dirs)
}
