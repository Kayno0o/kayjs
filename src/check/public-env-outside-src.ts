import type { CheckDiagnostic, CheckOptions } from '.'
import { readFile } from 'node:fs/promises'
import { relative } from 'node:path'
import { findProjectFiles } from '../build/files'
import { lintLevels } from '../compiler/lints'
import { positionAt } from '../compiler/mapping'
import { PUBLIC_FIELD, TEST_FILE } from '../server/env-state'

const TS_SOURCE = /\.[cm]?ts$/
const PUBLIC_FIELD_ALL = new RegExp(PUBLIC_FIELD.source, 'g')
const SRC_PREFIX = /^src[\\/]/

// An `s.Public` field in a `.ts` file outside `src`, which kay does not scan: the field types as a plain string in an island and the browser is not sent it.
export async function publicEnvOutsideSrc(root: string, options: CheckOptions): Promise<CheckDiagnostic[]> {
  const found: CheckDiagnostic[] = []

  for (const file of await findProjectFiles(root, TS_SOURCE, { project: true, ownOnly: true })) {
    if (SRC_PREFIX.test(relative(root, file)) || TEST_FILE.test(file) || file.endsWith('.d.ts'))
      continue

    const source = await readFile(file, 'utf8')
    const levelAt = lintLevels(source, options.lints)

    for (const match of source.matchAll(PUBLIC_FIELD_ALL)) {
      const level = levelAt('public-env-outside-src', match.index)

      if (level === 'allow')
        continue

      found.push({
        file,
        ...positionAt(source, match.index),
        end: match.index + match[0].length,
        message: 'This `s.Public` field is outside `src`, where kay finds the public environment, so an island reads it as a plain string and the browser is not sent it',
        help: 'declare the field in a `defineEnv` in a `.ts` module under `src`',
        code: 'public-env-outside-src',
        severity: level === 'warn' ? 'warning' : 'error',
      })
    }
  }

  return found
}
