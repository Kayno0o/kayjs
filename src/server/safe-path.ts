import { realpathSync, statSync } from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'

// The real path of the file `name` names inside `root`, or `undefined` when there is none: a name that climbs out with `..`, a symlink that leads out, a NUL byte, a missing file or a directory.
// The name is always read relative to `root`, so a leading slash is `root` itself and never the filesystem's; nothing is decoded, so `%2e%2e` is a file of that name.
// Symlinks are followed on both sides, so a root that is a symlink works and a link inside it pointing out does not.
export function safePath(root: string, name: string): string | undefined {
  if (name === '' || name.includes('\0'))
    return undefined

  try {
    const realRoot = realpathSync(resolve(root))
    const real = realpathSync(join(realRoot, name))
    const inside = relative(realRoot, real)

    if (inside === '' || inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside))
      return undefined

    return statSync(real, { throwIfNoEntry: false })?.isFile() === true ? real : undefined
  }
  catch {
    return undefined
  }
}
