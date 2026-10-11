import type { CheckDiagnostic } from '.'
import type { Fix } from '../compiler/ast'
import { ownFile } from './diagnose'

// Applies the first safe fix of each problem in the project's own files to its file, leaving out one whose edits overlap another's, and answers how many problems that fixed. A library's files are its own to fix.
export async function applySafeFixes(root: string, diagnostics: CheckDiagnostic[]): Promise<number> {
  const byFile = Map.groupBy(diagnostics.flatMap((diagnostic) => {
    const fix = diagnostic.fixes?.find(candidate => candidate.safe)

    return fix && ownFile(root, diagnostic.file) ? [{ file: diagnostic.file, fix }] : []
  }), found => found.file)
  let fixed = 0

  for (const [file, found] of byFile) {
    const taken: Fix['edits'] = []

    for (const { fix } of found) {
      if (fix.edits.some(edit => taken.some(other => edit.start < other.end && other.start < edit.end)))
        continue

      taken.push(...fix.edits)
      fixed++
    }

    const source = await Bun.file(file).text()

    await Bun.write(file, taken.sort((a, b) => b.start - a.start).reduce((text, edit) => text.slice(0, edit.start) + edit.text + text.slice(edit.end), source))
  }

  return fixed
}
