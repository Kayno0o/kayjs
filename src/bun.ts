import { isAbsolute, relative } from 'node:path'
import process from 'node:process'
import { engines } from '../package.json'

// Where a package keeps its files, the npm `bun` package its binary.
const NODE_MODULES = /[\\/]node_modules[\\/]/
// A canary counts as the release it leads to, which a range's prerelease rules would refuse; it fails open, so a 1.4.3 canary passes `>=1.4.3` though it may predate the release.
const PRERELEASE = /[-+].*$/

interface Runtime {
  version?: string
  path?: string
  // Where kay runs, standing for the project: a `bun` in its node_modules is the npm package a plugin's peer dependency installs.
  cwd?: string
  range?: string
}

// Why kay cannot run on this Bun, or nothing when it meets the `engines` of kay's package.json.
export function bunProblem({ version = Bun.version, path = process.execPath, cwd = process.cwd(), range = engines.bun }: Runtime = {}): string | undefined {
  if (Bun.semver.satisfies(version.replace(PRERELEASE, ''), range))
    return undefined

  const fix = projectBun(path, cwd) ? 'a dependency installed the npm `bun` package, which package scripts run ahead of the system Bun; run `bun update bun`' : 'run `bun upgrade`'

  return `Bun ${version} at ${path} is under the ${range} kay needs: ${fix}`
}

// Whether `path` is in the node_modules of `cwd` or of a directory above it, as a workspace hoists it, rather than a global install's. `kay dev` run from outside the project, given its directory, gets `bun upgrade` instead.
function projectBun(path: string, cwd: string): boolean {
  const match = NODE_MODULES.exec(path)

  if (match === null)
    return false

  const above = relative(path.slice(0, match.index), cwd)

  return !above.startsWith('..') && !isAbsolute(above)
}
