import process from 'node:process'
import { engines } from '../package.json'

// Where the npm `bun` package keeps its binary: a plugin's peer dependency installs it, and package scripts run it ahead of the system Bun.
const NPM_BUN = /[\\/]node_modules[\\/]/
// A canary counts as the release it leads to, which a range's prerelease rules would refuse.
const PRERELEASE = /[-+].*$/

// Why kay cannot run on this Bun, or nothing when it meets the `engines` of kay's package.json.
export function bunProblem(version: string = Bun.version, path: string = process.execPath): string | undefined {
  if (Bun.semver.satisfies(version.replace(PRERELEASE, ''), engines.bun))
    return undefined

  const fix = NPM_BUN.test(path) ? 'a dependency installed the npm `bun` package, which package scripts run ahead of the system Bun; run `bun update bun`' : 'run `bun upgrade`'

  return `kay needs Bun ${engines.bun}, and runs on Bun ${version} at ${path}: ${fix}`
}
