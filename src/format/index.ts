import type { Diagnostic } from '../compiler'
import { stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import { findKayFiles } from '../build/files'
import { formatKay } from '../compiler/format'

export { formatKay } from '../compiler/format'

export interface FormatFilesResult {
  // Files whose formatting differs: rewritten, or only listed when `write` is false.
  changed: string[]
  errors: { file: string, source: string, diagnostics: Diagnostic[] }[]
}

// Formats the .kay files at `paths`, each a file or a directory searched recursively.
export async function formatFiles(paths: string[], options: { write: boolean }): Promise<FormatFilesResult> {
  const files = (await Promise.all(paths.map(async path => (await stat(path)).isDirectory() ? findKayFiles(resolve(path)) : [resolve(path)]))).flat()
  const result: FormatFilesResult = { changed: [], errors: [] }

  await Promise.all(files.map(async (file) => {
    const source = await Bun.file(file).text()
    const { code, diagnostics } = formatKay(source)

    if (diagnostics.length > 0)
      result.errors.push({ file, source, diagnostics })
    else if (code !== source)
      result.changed.push(file)

    if (options.write && code !== source)
      await Bun.write(file, code)
  }))

  result.changed.sort()
  result.errors.sort((a, b) => a.file.localeCompare(b.file))

  return result
}
