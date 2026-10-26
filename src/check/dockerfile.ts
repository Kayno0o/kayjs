import type { CheckDiagnostic } from '.'
import type { LintLevels } from '../compiler/lints'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { engines } from '../../package.json'
import { lintLevel } from '../compiler/lints'

// A root file named `Dockerfile`, `Dockerfile.prod` or `app.Dockerfile`.
const DOCKERFILE = /^(?:.+\.)?Dockerfile(?:\..+)?$/
// A `FROM` of the Bun image at a full version, with the variant tag after it and the digest that pins it: the version is checked, the rest kept apart from it.
const BUN_IMAGE = /^(\s*FROM\s+(?:--\S+\s+)?)oven\/bun:(\d+\.\d+\.\d+)((?:-[\w.-]+)?)(@sha256:[0-9a-f]+)?(?=\s|$)/gim
const MINIMUM = /^>=\s*(\d+\.\d+\.\d+)$/

// The Dockerfiles of the project root building from a Bun older than the one kay needs, each with a safe fix to the oldest Bun that runs it: the build stage fails at `bun install` or at the first `kay` command otherwise. An image pinned by digest loses it, as the digest would keep the old Bun whatever the tag says.
export function dockerfileProblems(root: string, levels: LintLevels | undefined, range = engines.bun): CheckDiagnostic[] {
  const level = lintLevel('old-bun-image', levels)
  const minimum = MINIMUM.exec(range)?.[1]

  if (level === 'allow' || minimum === undefined)
    return []

  const found: CheckDiagnostic[] = []

  for (const name of readdirSync(root).filter(entry => DOCKERFILE.test(entry)).sort()) {
    const file = join(root, name)
    let source: string

    try {
      source = readFileSync(file, 'utf8')
    }
    catch {
      continue
    }

    for (const match of source.matchAll(BUN_IMAGE)) {
      const [whole, from = '', version = '', variant = '', digest] = match

      if (Bun.semver.order(version, minimum) !== -1)
        continue

      const start = match.index + from.length + 'oven/bun:'.length
      const before = source.slice(0, start).split('\n')

      found.push({
        file,
        line: before.length,
        column: before.at(-1)!.length + 1,
        end: match.index + whole.length,
        severity: level === 'warn' ? 'warning' : 'error',
        code: 'old-bun-image',
        message: `${name} builds from \`oven/bun:${version}\`, under the Bun ${range} kay needs`,
        help: `build from \`oven/bun:${minimum}${variant}\`${digest === undefined ? '' : ', dropping its digest'}, or newer`,
        fixes: [{ title: `build from oven/bun:${minimum}${variant}`, safe: true, edits: [{ start, end: match.index + whole.length, text: `${minimum}${variant}` }] }],
      })
    }
  }

  return found
}
