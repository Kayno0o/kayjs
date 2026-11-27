// Path confinement, on its own so the server can check a path without loading the build's file helpers and `node:zlib` with them.

import { isAbsolute, relative } from 'node:path'

/** Whether `target` lies under `dir`, or is `dir` itself with `orSame`. Paths are compared as written: realpath both first to follow symlinks. */
export function isInside(dir: string, target: string, options: { orSame?: boolean } = {}): boolean {
  const rel = relative(dir, target)
  if (rel === '')
    return options.orSame === true
  // `..x` is a name inside `dir`; only `..` itself, as a whole segment, leaves it.
  return rel !== '..' && !rel.startsWith('../') && !rel.startsWith('..\\') && !isAbsolute(rel)
}
