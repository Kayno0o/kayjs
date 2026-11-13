import { existsSync } from 'node:fs'
import { join, relative } from 'node:path'

const GIT_PREFIX = /^git\+/
const CHANGE_FILES = ['MIGRATION.md', 'UPGRADING.md', 'CHANGELOG.md']

// Whether going from `from` to `to` is a major, a 0.x minor counting as one.
function crossesMajor(from: string, to: string): boolean {
  const [fromMajor, fromMinor] = from.split('.').map(Number)
  const [toMajor, toMinor] = to.split('.').map(Number)

  return fromMajor !== toMajor || (fromMajor === 0 && fromMinor !== toMinor)
}

// The warning for a package raised from `held` to `wanted` across a major, pointing at its installed migration file (path from the app) or else its repository; undefined when it stayed within a major.
export function majorWarning(root: string, name: string, held: string, wanted: string, installed: { dir: string, repository?: string | { url?: string } } | undefined): string | undefined {
  if (!crossesMajor(held, wanted))
    return undefined

  const file = installed === undefined ? undefined : CHANGE_FILES.map(file => join(installed.dir, file)).find(path => existsSync(path))
  const repository = typeof installed?.repository === 'string' ? installed.repository : installed?.repository?.url
  const where = file === undefined ? repository?.replace(GIT_PREFIX, '') : relative(root, file)
  const notes = where === undefined ? '' : `: what changed is ${file === undefined ? 'at' : 'in'} ${where}`

  return `${name} was raised from ${held} to ${wanted}, across a major, so its API may have changed${notes}`
}
